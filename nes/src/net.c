/*
 * Two machines, one game: 2-player lockstep netplay.
 *
 * The transport is a single TCP connection between the guests. The WebRTC
 * bridge already puts both VMs on one L2 segment with static 10.0.2.x
 * addresses, so "netplay" needs no page-side work at all -- the frames
 * ride the same virtio -> RTCDataChannel path as a ping would.
 *
 * The model is the oldest one in the book, because it is the only one this
 * CPU budget affords: both sides run the same deterministic core and
 * exchange nothing but controller bytes. Each side promises its input D
 * frames ahead of use (D = the input delay, default 3 ~ 50 ms), so by the
 * time frame N is executed, both pads for N are normally already here and
 * nobody waits. Rollback would need frame re-simulation headroom that an
 * emulated i686 running at ~130% realtime simply does not have.
 *
 * The host is P1 and the authority: a joiner fetches the ROM and the
 * machine state (agnes core + our APU, whose $4015 reads feed the CPU)
 * over the wire, which kills the classic "our ROMs differ by one byte"
 * desync at the root. Every 60 frames the sides swap a CRC of the core
 * state as a tripwire; on a mismatch the host pushes a fresh state (a new
 * "epoch") and the match continues with a one-second hiccup instead of
 * dying. Wire format is packed little-endian structs -- every machine
 * that can run this build is little-endian.
 */
#include "nes.h"

#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define NET_PROTO 1
#define CRC_EVERY 60      /* frames between state CRC exchanges */
#define RING 16           /* input/CRC ring slots; needs only delay+1 <= 7 */
#define WAIT_SLICE_MS 200 /* keep q/ctrl-c responsive while stalled */
#define WAIT_TOTAL_MS 30000

/* In-match prints: the tty is raw while the game runs, so every line needs
 * the \r\n treatment (same convention as lua_glue's say()) or it shears. */
#define SAY(...)                              \
	do {                                  \
		fprintf(stderr, "\r\n");      \
		fprintf(stderr, __VA_ARGS__); \
		fprintf(stderr, "\r\n");      \
	} while (0)

enum {
	MSG_HELLO = 'H', /* proto + version -- both sides send first */
	MSG_START = 'S', /* host: delay + ROM + machine state */
	MSG_INPUT = 'I', /* epoch + frame + pad byte */
	MSG_CRC = 'C',   /* epoch + frame + state crc32 */
	MSG_NEED = 'N',  /* joiner: my crc disagrees, push me a state */
	MSG_RESYNC = 'R', /* host: new epoch + machine state */
	MSG_BYE = 'B',
};

struct net {
	int fd; /* the match: one TCP stream */
	bool host;
	int delay;
	int hold_frames; /* for input_poll while stalled in a wait */
	agnes_t *agnes;

	unsigned long frame; /* frames since this epoch started */
	uint8_t epoch;
	bool need_sent; /* joiner: one MSG_NEED per epoch is plenty */

	/* Inputs promised to the peer live here until their frame comes up;
	 * remote slots are tagged because the peer runs up to D frames off. */
	uint8_t local_q[RING];
	struct {
		unsigned long frame;
		uint8_t pad;
		bool valid;
	} remote_q[RING];

	/* CRCs by exchange index (frame / CRC_EVERY); ours and the peer's
	 * arrive in either order, compare when both sides of a slot exist. */
	struct {
		unsigned long frame;
		uint32_t crc;
		bool valid;
	} own_crc[RING], peer_crc[RING];

	/* Presses caught while stalled waiting for the peer; folded into the
	 * next frame's poll so nothing is dropped. */
	agnes_input_t carry;

	agnes_state_t *state_buf; /* scratch for dumps: agnes + APU appended */
	size_t agnes_size, apu_size;

	char describe_buf[64];
};

/* ── little endian on the wire (both i686 and any host we build on) ── */

static void put_u32(uint8_t *p, uint32_t v) {
	memcpy(p, &v, 4);
}

static uint32_t get_u32(const uint8_t *p) {
	uint32_t v;
	memcpy(&v, p, 4);
	return v;
}

static uint8_t pack_pad(const agnes_input_t *in) {
	return (uint8_t)((in->a << 0) | (in->b << 1) | (in->select << 2) | (in->start << 3) |
	                 (in->up << 4) | (in->down << 5) | (in->left << 6) | (in->right << 7));
}

static void unpack_pad(uint8_t b, agnes_input_t *out) {
	out->a = b & 0x01;
	out->b = b & 0x02;
	out->select = b & 0x04;
	out->start = b & 0x08;
	out->up = b & 0x10;
	out->down = b & 0x20;
	out->left = b & 0x40;
	out->right = b & 0x80;
}

static long long now_ms(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static uint32_t crc32_buf(uint32_t crc, const void *buf, size_t len) {
	static uint32_t table[256];
	if (!table[1]) {
		for (uint32_t i = 0; i < 256; i++) {
			uint32_t c = i;
			for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320u & (0u - (c & 1)));
			table[i] = c;
		}
	}
	const uint8_t *p = buf;
	crc = ~crc;
	while (len--) crc = table[(crc ^ *p++) & 0xff] ^ (crc >> 8);
	return ~crc;
}

/* ── send/recv with a deadline, EINTR = quit in flight ──
 *
 * The peer's tab closing kills the bridge SILENTLY -- no FIN, no RST, the
 * wire just stops. A bare blocking recv() caught mid-message (the 84 KB
 * resync push is the widest window) would sit there forever, immune to q
 * (nobody pumps input here) and to ctrl-c (the tty is raw, ^C is just a
 * byte). Every chunk therefore waits at most WAIT_TOTAL_MS for the socket
 * to turn ready; any actual progress resets the clock. */

static bool io_wait(int fd, short events) {
	for (int waited_ms = 0; waited_ms < WAIT_TOTAL_MS; waited_ms += WAIT_SLICE_MS) {
		struct pollfd pfd = {fd, events, 0};
		int r = poll(&pfd, 1, WAIT_SLICE_MS);
		if (r > 0) return true;
		if (r < 0 && errno != EINTR) return false;
	}
	SAY("nes: the link went silent for %ds -- match over", WAIT_TOTAL_MS / 1000);
	return false;
}

static bool send_exact(int fd, const void *buf, size_t len) {
	const uint8_t *p = buf;
	while (len > 0) {
		if (!io_wait(fd, POLLOUT)) return false;
		ssize_t k = send(fd, p, len, 0);
		if (k <= 0) {
			if (k < 0 && errno == EINTR) continue;
			return false;
		}
		p += k;
		len -= (size_t)k;
	}
	return true;
}

static bool recv_exact(int fd, void *buf, size_t len) {
	uint8_t *p = buf;
	while (len > 0) {
		if (!io_wait(fd, POLLIN)) return false;
		ssize_t k = recv(fd, p, len, 0);
		if (k <= 0) {
			if (k < 0 && errno == EINTR) continue;
			return false;
		}
		p += k;
		len -= (size_t)k;
	}
	return true;
}

/* ── handshake, shared by both roles ── */

static bool hello_exchange(int fd) {
	/* Two fingerprints: NES_VERSION covers our own code (the APU, this
	 * protocol -- where determinism actually lives) and the agnes version
	 * covers the vendored core. Different builds may disagree on
	 * determinism; refuse loudly rather than desync mysteriously. The
	 * array init zero-fills, so the padding compares deterministically. */
	uint8_t mine[18] = {MSG_HELLO, NET_PROTO};
	snprintf((char *)mine + 2, 8, "%s", NES_VERSION);
	snprintf((char *)mine + 10, 8, "%s", AGNES_VERSION_STRING);
	if (!send_exact(fd, mine, sizeof(mine))) return false;
	uint8_t theirs[18];
	if (!recv_exact(fd, theirs, sizeof(theirs))) {
		fprintf(stderr, "nes: peer hung up during handshake\n");
		return false;
	}
	if (theirs[0] != MSG_HELLO || theirs[1] != NET_PROTO ||
	    memcmp(theirs + 2, mine + 2, sizeof(mine) - 2) != 0) {
		fprintf(stderr, "nes: version mismatch -- both sides must run the same build\n");
		return false;
	}
	return true;
}

static net_t *net_new(int fd, bool host, int delay, int hold_frames) {
	/* A peer hanging up must be an EPIPE we report, not a SIGPIPE that
	 * silently kills us mid-frame. */
	signal(SIGPIPE, SIG_IGN);
	net_t *n = calloc(1, sizeof(*n));
	if (!n) return NULL;
	n->fd = fd;
	n->host = host;
	n->delay = delay;
	n->hold_frames = hold_frames;
	int one = 1;
	setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
	return n;
}

/* Allocate the dump scratch once the core exists: agnes state + APU blob. */
static bool state_buf_make(net_t *n, agnes_t *agnes) {
	n->agnes = agnes;
	n->agnes_size = agnes_state_size();
#ifdef NES_APU
	n->apu_size = apu_state_size();
#endif
	n->state_buf = malloc(n->agnes_size + n->apu_size);
	return n->state_buf != NULL;
}

static void state_dump(net_t *n) {
	agnes_dump_state(n->agnes, n->state_buf);
#ifdef NES_APU
	apu_dump_state((uint8_t *)n->state_buf + n->agnes_size);
#endif
}

static bool state_restore(net_t *n) {
	if (!agnes_restore_state(n->agnes, n->state_buf)) return false;
#ifdef NES_APU
	apu_restore_state((const uint8_t *)n->state_buf + n->agnes_size);
#endif
	return true;
}

/* ── host: listen, answer discovery probes, accept, handshake ── */

/* Our own address: the first non-loopback IPv4 interface. (The classic
 * "connect a UDP socket toward the internet and getsockname" trick needs
 * a default route, which an offline guest does not have.) */
static bool own_ip(struct in_addr *out) {
	struct ifaddrs *all;
	if (getifaddrs(&all)) return false;
	bool ok = false;
	for (struct ifaddrs *ifa = all; ifa; ifa = ifa->ifa_next) {
		if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
		struct in_addr a = ((struct sockaddr_in *)ifa->ifa_addr)->sin_addr;
		if ((ntohl(a.s_addr) >> 24) == 127) continue;
		*out = a;
		ok = true;
		break;
	}
	freeifaddrs(all);
	return ok;
}

/* Is this one of our own addresses? Walks every interface, not just the
 * first: a discovery answer must be recognized as "this machine" even on
 * a multi-homed host. */
static bool is_own_addr(struct in_addr a) {
	struct ifaddrs *all;
	if (getifaddrs(&all)) return false;
	bool mine = false;
	for (struct ifaddrs *ifa = all; ifa && !mine; ifa = ifa->ifa_next) {
		if (!ifa->ifa_addr || ifa->ifa_addr->sa_family != AF_INET) continue;
		mine = ((struct sockaddr_in *)ifa->ifa_addr)->sin_addr.s_addr == a.s_addr;
	}
	freeifaddrs(all);
	return mine;
}

net_t *net_host_wait(int port, int delay, int hold_frames, const char *rom_name) {
	int lfd = socket(AF_INET, SOCK_STREAM, 0);
	if (lfd < 0) return NULL;
	int one = 1;
	setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
	struct sockaddr_in addr = {0};
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_ANY);
	addr.sin_port = htons((uint16_t)port);
	if (bind(lfd, (struct sockaddr *)&addr, sizeof(addr)) || listen(lfd, 1)) {
		fprintf(stderr, "nes: cannot listen on :%d\n", port);
		close(lfd);
		return NULL;
	}

	/* The discovery responder: a bare `nes join` probes the LAN; the
	 * answer names the game, so a joiner picking between several hosts
	 * knows what it is picking. */
	int ufd = socket(AF_INET, SOCK_DGRAM, 0);
	if (ufd >= 0) {
		setsockopt(ufd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
		if (bind(ufd, (struct sockaddr *)&addr, sizeof(addr))) {
			close(ufd);
			ufd = -1;
		}
	}
	uint8_t nesa[5 + NET_GAME_NAME_MAX] = "NESA";
	size_t name_len = strlen(rom_name);
	if (name_len > NET_GAME_NAME_MAX) name_len = NET_GAME_NAME_MAX;
	nesa[4] = (uint8_t)name_len;
	memcpy(nesa + 5, rom_name, name_len);
	size_t nesa_len = 5 + name_len;

	/* The bridge-style banner: not "put your address here" homework but
	 * the literal line the other person types. */
	char joinarg[24] = "<this machine's ip>";
	struct in_addr self;
	if (own_ip(&self)) {
		char ipstr[INET_ADDRSTRLEN];
		inet_ntop(AF_INET, &self, ipstr, sizeof(ipstr));
		if (port == NET_DEFAULT_PORT) {
			snprintf(joinarg, sizeof(joinarg), "%s", ipstr);
		} else {
			snprintf(joinarg, sizeof(joinarg), "%s:%d", ipstr, port);
		}
	}
	printf("netplay: hosting %s on :%d -- a friend joins with:\n", rom_name, port);
	printf("\n    nes join %s\n\n", joinarg);
	printf("netplay: waiting for P2 (a bare `nes join` also finds us; ctrl-c aborts)\n");
	fflush(stdout);

	int fd = -1;
	for (;;) {
		struct pollfd pfds[2] = {{lfd, POLLIN, 0}, {ufd, POLLIN, 0}};
		int r = poll(pfds, ufd >= 0 ? 2 : 1, -1);
		if (r < 0) {
			if (errno == EINTR) { /* ctrl-c while waiting */
				close(lfd);
				if (ufd >= 0) close(ufd);
				return NULL;
			}
			continue;
		}
		if (ufd >= 0 && (pfds[1].revents & POLLIN)) {
			char probe[8];
			struct sockaddr_in from;
			socklen_t flen = sizeof(from);
			ssize_t k = recvfrom(ufd, probe, sizeof(probe), 0, (struct sockaddr *)&from,
			                     &flen);
			if (k == 4 && memcmp(probe, "NESQ", 4) == 0) {
				sendto(ufd, nesa, nesa_len, 0, (struct sockaddr *)&from, flen);
			}
		}
		if (pfds[0].revents & POLLIN) {
			struct sockaddr_in peer;
			socklen_t plen = sizeof(peer);
			fd = accept(lfd, (struct sockaddr *)&peer, &plen);
			if (fd >= 0) {
				char ip[INET_ADDRSTRLEN] = "?";
				inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof(ip));
				printf("netplay: P2 arrived from %s\n", ip);
				break;
			}
		}
	}
	close(lfd);
	/* Stop answering discovery probes: with P2 in, an answer would only
	 * lure a third player into a refused connect. */
	if (ufd >= 0) close(ufd);

	if (!hello_exchange(fd)) {
		close(fd);
		return NULL;
	}
	net_t *n = net_new(fd, true, delay, hold_frames);
	if (!n) {
		close(fd);
		return NULL;
	}
	snprintf(n->describe_buf, sizeof(n->describe_buf), "P1 (host) on :%d, delay %d", port,
	         delay);
	return n;
}

bool net_host_start(net_t *n, const uint8_t *rom, size_t rom_size, agnes_t *agnes) {
	if (!state_buf_make(n, agnes)) return false;
	state_dump(n);
	uint8_t hdr[14] = {MSG_START, (uint8_t)n->delay};
	put_u32(hdr + 2, (uint32_t)rom_size);
	put_u32(hdr + 6, (uint32_t)n->agnes_size);
	put_u32(hdr + 10, (uint32_t)n->apu_size);
	if (!send_exact(n->fd, hdr, sizeof(hdr)) || !send_exact(n->fd, rom, rom_size) ||
	    !send_exact(n->fd, n->state_buf, n->agnes_size + n->apu_size)) {
		fprintf(stderr, "nes: peer vanished while sending the ROM\n");
		return false;
	}
	return true;
}

/* ── joiner: discover (maybe), connect, pull ROM + state ── */

int net_discover(net_host_t *out, int max, int port) {
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	if (fd < 0) return 0;
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &one, sizeof(one));
	struct sockaddr_in to = {0};
	to.sin_family = AF_INET;
	to.sin_port = htons((uint16_t)port);

	struct in_addr self = {0};
	bool have_self = own_ip(&self);

	/* Up to 5 probe rounds, but every round drains its FULL 1-second
	 * window: with several hosts up, the first answer must not cut the
	 * collection short. One round that heard anybody is enough. */
	int found = 0;
	for (int attempt = 0; attempt < 5 && found == 0; attempt++) {
		/* The broadcast probe covers any conventional LAN... */
		to.sin_addr.s_addr = htonl(INADDR_BROADCAST);
		sendto(fd, "NESQ", 4, 0, (struct sockaddr *)&to, sizeof(to));
		/* ...but the bridged vinx fabric floods ARP and nothing else, so
		 * also sweep our own /24 with unicast probes -- 254 four-byte
		 * packets, cheaper than one typo'd address. Our own address is
		 * probed too, on purpose: a host backgrounded on this very
		 * machine belongs on the list, and this kernel does not loop
		 * broadcasts back to local listeners. */
		if (have_self) {
			uint32_t base = ntohl(self.s_addr) & 0xffffff00u;
			for (uint32_t i = 1; i < 255; i++) {
				to.sin_addr.s_addr = htonl(base | i);
				sendto(fd, "NESQ", 4, 0, (struct sockaddr *)&to, sizeof(to));
			}
		}
		for (long long end = now_ms() + 1000;;) {
			int left = (int)(end - now_ms());
			if (left <= 0) break;
			struct pollfd pfd = {fd, POLLIN, 0};
			if (poll(&pfd, 1, left) <= 0 || !(pfd.revents & POLLIN)) continue;
			uint8_t reply[5 + NET_GAME_NAME_MAX];
			struct sockaddr_in from;
			socklen_t flen = sizeof(from);
			ssize_t k = recvfrom(fd, reply, sizeof(reply), 0, (struct sockaddr *)&from,
			                     &flen);
			if (k < 4 || memcmp(reply, "NESA", 4) != 0) continue;
			char addr[16];
			inet_ntop(AF_INET, &from.sin_addr, addr, sizeof(addr));
			int i = 0;
			while (i < found && strcmp(out[i].addr, addr) != 0) i++;
			if (i < found || found >= max) continue; /* seen, or full */
			snprintf(out[found].addr, sizeof(out[found].addr), "%s", addr);
			/* "NESA" + length + basename; a bare 4-byte answer still
			 * counts as a host, just a nameless one. */
			size_t nl = 0;
			if (k >= 5) {
				nl = reply[4];
				if (nl > (size_t)(k - 5)) nl = (size_t)(k - 5);
			}
			memcpy(out[found].game, reply + 5, nl);
			out[found].game[nl] = '\0';
			if (nl == 0) snprintf(out[found].game, sizeof(out[found].game), "?");
			out[found].self = is_own_addr(from.sin_addr);
			found++;
		}
	}
	close(fd);
	return found;
}

net_t *net_join_begin(const char *host, int port, int hold_frames) {
	struct in_addr ip;
	if (!inet_pton(AF_INET, host, &ip)) {
		fprintf(stderr, "nes: join wants an IPv4 address, got %s\n", host);
		return NULL;
	}

	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0) return NULL;
	struct sockaddr_in addr = {0};
	addr.sin_family = AF_INET;
	addr.sin_addr = ip;
	addr.sin_port = htons((uint16_t)port);
	char ipstr[INET_ADDRSTRLEN] = "?";
	inet_ntop(AF_INET, &ip, ipstr, sizeof(ipstr));
	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr))) {
		fprintf(stderr, "nes: cannot reach %s:%d -- same bridge LAN? host running?\n",
		        ipstr, port);
		close(fd);
		return NULL;
	}
	if (!hello_exchange(fd)) {
		close(fd);
		return NULL;
	}
	net_t *n = net_new(fd, false, 0, hold_frames);
	if (!n) {
		close(fd);
		return NULL;
	}
	snprintf(n->describe_buf, sizeof(n->describe_buf), "P2 joined %s:%d", ipstr, port);
	return n;
}

uint8_t *net_join_rom(net_t *n, size_t *out_size) {
	uint8_t hdr[14];
	if (!recv_exact(n->fd, hdr, sizeof(hdr)) || hdr[0] != MSG_START) {
		fprintf(stderr, "nes: host never sent the ROM\n");
		return NULL;
	}
	n->delay = hdr[1];
	uint32_t rom_size = get_u32(hdr + 2);
	n->agnes_size = get_u32(hdr + 6);
	n->apu_size = get_u32(hdr + 10);
	if (rom_size == 0 || rom_size > 8u * 1024 * 1024) {
		fprintf(stderr, "nes: host sent a nonsense ROM size (%u)\n", rom_size);
		return NULL;
	}
	uint8_t *rom = malloc(rom_size);
	if (!rom || !recv_exact(n->fd, rom, rom_size)) {
		fprintf(stderr, "nes: link died while pulling the ROM\n");
		free(rom);
		return NULL;
	}
	printf("netplay: pulled the ROM from the host (%u bytes), delay %d frames\n", rom_size,
	       n->delay);
	*out_size = rom_size;
	char at[24];
	snprintf(at, sizeof(at), ", delay %d", n->delay);
	strncat(n->describe_buf, at, sizeof(n->describe_buf) - strlen(n->describe_buf) - 1);
	return rom;
}

bool net_join_state(net_t *n, agnes_t *agnes) {
	/* Sizes must agree exactly: same build, same structs. */
	if (n->agnes_size != agnes_state_size()
#ifdef NES_APU
	    || n->apu_size != apu_state_size()
#endif
	) {
		fprintf(stderr, "nes: state size mismatch -- differing builds?\n");
		return false;
	}
	n->agnes = agnes;
	n->state_buf = malloc(n->agnes_size + n->apu_size);
	if (!n->state_buf ||
	    !recv_exact(n->fd, n->state_buf, n->agnes_size + n->apu_size)) {
		fprintf(stderr, "nes: link died while pulling the machine state\n");
		return false;
	}
	if (!state_restore(n)) {
		fprintf(stderr, "nes: the host's machine state would not load\n");
		return false;
	}
	return true;
}

/* ── the lockstep heart ── */

static void epoch_reset(net_t *n, uint8_t epoch) {
	n->epoch = epoch;
	n->frame = 0;
	n->need_sent = false;
	memset(n->local_q, 0, sizeof(n->local_q));
	memset(n->remote_q, 0, sizeof(n->remote_q));
	memset(n->own_crc, 0, sizeof(n->own_crc));
	memset(n->peer_crc, 0, sizeof(n->peer_crc));
}

/* Host side of a desync: push the current state as a new epoch. */
static bool host_resync(net_t *n) {
	SAY("netplay: desync detected -- pushing a fresh state");
	epoch_reset(n, (uint8_t)(n->epoch + 1));
	state_dump(n);
	uint8_t hdr[6] = {MSG_RESYNC, n->epoch};
	put_u32(hdr + 2, (uint32_t)(n->agnes_size + n->apu_size));
	return send_exact(n->fd, hdr, sizeof(hdr)) &&
	       send_exact(n->fd, n->state_buf, n->agnes_size + n->apu_size);
}

/* A CRC pair for one frame is complete -- do they agree? Only the joiner
 * escalates: the host is authority, its reaction is the resync itself. */
static bool crc_compare(net_t *n, unsigned long frame, uint32_t own, uint32_t peer,
                        bool *resynced) {
	if (own == peer) {
		if (frame % 600 == 0) { /* once every ~10 s, keep the log calm */
			SAY("netplay: sync ok at frame %lu", frame);
		}
		return true;
	}
	if (n->host) {
		if (!host_resync(n)) return false;
		*resynced = true;
		return true;
	}
	if (!n->need_sent) {
		n->need_sent = true;
		uint8_t msg[2] = {MSG_NEED, n->epoch};
		SAY("netplay: desync detected -- asking the host for a state");
		if (!send_exact(n->fd, msg, sizeof(msg))) return false;
	}
	return true;
}

/* Read one message and fold it into the rings. `*resynced` flips when an
 * epoch change happened (the caller's frame counter is void then). */
static bool pump_one(net_t *n, bool *resynced) {
	uint8_t type;
	if (!recv_exact(n->fd, &type, 1)) return false;
	switch (type) {
	case MSG_INPUT: {
		uint8_t b[6];
		if (!recv_exact(n->fd, b, sizeof(b))) return false;
		if (b[0] != n->epoch) return true; /* stale epoch, drop */
		unsigned long frame = get_u32(b + 1);
		int slot = (int)(frame % RING);
		n->remote_q[slot].frame = frame;
		n->remote_q[slot].pad = b[5];
		n->remote_q[slot].valid = true;
		return true;
	}
	case MSG_CRC: {
		uint8_t b[9];
		if (!recv_exact(n->fd, b, sizeof(b))) return false;
		if (b[0] != n->epoch) return true;
		unsigned long frame = get_u32(b + 1);
		uint32_t crc = get_u32(b + 5);
		int slot = (int)((frame / CRC_EVERY) % RING);
		n->peer_crc[slot].frame = frame;
		n->peer_crc[slot].crc = crc;
		n->peer_crc[slot].valid = true;
		if (n->own_crc[slot].valid && n->own_crc[slot].frame == frame) {
			return crc_compare(n, frame, n->own_crc[slot].crc, crc, resynced);
		}
		return true;
	}
	case MSG_NEED: {
		uint8_t epoch;
		if (!recv_exact(n->fd, &epoch, 1)) return false;
		if (!n->host || epoch != n->epoch) return true;
		if (!host_resync(n)) return false;
		*resynced = true;
		return true;
	}
	case MSG_RESYNC: {
		uint8_t hdr[5];
		if (!recv_exact(n->fd, hdr, sizeof(hdr))) return false;
		uint32_t size = get_u32(hdr + 1);
		if (size != n->agnes_size + n->apu_size) {
			fprintf(stderr, "nes: resync size mismatch\n");
			return false;
		}
		if (!recv_exact(n->fd, n->state_buf, size)) return false;
		epoch_reset(n, hdr[0]);
		if (!state_restore(n)) return false;
		SAY("netplay: resynced to the host's state");
		*resynced = true;
		return true;
	}
	case MSG_BYE:
		SAY("netplay: the other side left");
		return false;
	default:
		SAY("nes: garbage on the wire (0x%02x)", type);
		return false;
	}
}

bool net_exchange(net_t *n, const agnes_input_t *local, bool *quit, agnes_input_t *p1,
                  agnes_input_t *p2) {
	static const agnes_input_t none;
	bool resynced = false;

	/* q pressed this frame: net_close (right behind the caller's break)
	 * waves the BYE; nothing to exchange any more. */
	if (*quit) return false;

	/* Presses that landed while a previous wait stalled ride this frame. */
	agnes_input_t mine = *local;
	mine.a |= n->carry.a;
	mine.b |= n->carry.b;
	mine.select |= n->carry.select;
	mine.start |= n->carry.start;
	mine.up |= n->carry.up;
	mine.down |= n->carry.down;
	mine.left |= n->carry.left;
	mine.right |= n->carry.right;
	n->carry = none;

	/* Promise frame N+D to the peer and remember it for our own turn. */
	unsigned long promise = n->frame + (unsigned long)n->delay;
	n->local_q[promise % RING] = pack_pad(&mine);
	uint8_t msg[7] = {MSG_INPUT, n->epoch};
	put_u32(msg + 2, (uint32_t)promise);
	msg[6] = n->local_q[promise % RING];
	if (!send_exact(n->fd, msg, sizeof(msg))) {
		SAY("nes: peer vanished");
		return false;
	}

	/* The tripwire: swap state CRCs on the cadence. The state here is
	 * "after frame N-1", which is the same point on both sides. */
	if (n->frame % CRC_EVERY == 0) {
		state_dump(n);
		uint32_t crc = crc32_buf(0, n->state_buf, n->agnes_size + n->apu_size);
		int slot = (int)((n->frame / CRC_EVERY) % RING);
		n->own_crc[slot].frame = n->frame;
		n->own_crc[slot].crc = crc;
		n->own_crc[slot].valid = true;
		uint8_t cmsg[10] = {MSG_CRC, n->epoch};
		put_u32(cmsg + 2, (uint32_t)n->frame);
		put_u32(cmsg + 6, crc);
		if (!send_exact(n->fd, cmsg, sizeof(cmsg))) return false;
		if (n->peer_crc[slot].valid && n->peer_crc[slot].frame == n->frame) {
			if (!crc_compare(n, n->frame, crc, n->peer_crc[slot].crc, &resynced))
				return false;
		}
	}

	/* The first D frames of an epoch have no promised inputs yet -- both
	 * sides pad with neutral, by construction identical. */
	if (!resynced && n->frame < (unsigned long)n->delay) {
		*p1 = *p2 = none;
		n->frame++;
		return true;
	}

	/* Wait for the peer's pad for frame N. Normally it is already in the
	 * ring (it left the peer D frames ago); a stall means the wire or the
	 * other tab is slow -- keep polling input so q still quits, and fold
	 * any presses into the carry for the next frame. */
	int waited_ms = 0;
	while (!resynced) {
		int slot = (int)(n->frame % RING);
		if (n->remote_q[slot].valid && n->remote_q[slot].frame == n->frame) break;
		struct pollfd pfd = {n->fd, POLLIN, 0};
		int r = poll(&pfd, 1, WAIT_SLICE_MS);
		if (r < 0 && errno != EINTR) return false;
		if (r > 0) {
			if (!pump_one(n, &resynced)) return false;
			continue;
		}
		agnes_input_t stall = none;
		input_poll(&stall, quit, n->hold_frames);
		n->carry.a |= stall.a;
		n->carry.b |= stall.b;
		n->carry.select |= stall.select;
		n->carry.start |= stall.start;
		n->carry.up |= stall.up;
		n->carry.down |= stall.down;
		n->carry.left |= stall.left;
		n->carry.right |= stall.right;
		if (*quit) return false; /* net_close sends the goodbye */
		waited_ms += WAIT_SLICE_MS;
		if (waited_ms >= WAIT_TOTAL_MS) {
			SAY("nes: peer silent for %ds -- giving up", WAIT_TOTAL_MS / 1000);
			return false;
		}
	}

	if (resynced) {
		/* Epoch flipped under us: this tick runs neutral on both sides
		 * (the peer does the same right after its restore/dump), and the
		 * next exchange is frame 0 of the new epoch. */
		*p1 = *p2 = none;
		return true;
	}

	agnes_input_t remote;
	unpack_pad(n->remote_q[n->frame % RING].pad, &remote);
	agnes_input_t self;
	unpack_pad(n->local_q[n->frame % RING], &self);
	if (n->host) {
		*p1 = self;
		*p2 = remote;
	} else {
		*p1 = remote;
		*p2 = self;
	}
	n->frame++;
	return true;
}

void net_close(net_t *n) {
	if (!n) return;
	if (n->fd >= 0) {
		uint8_t bye = MSG_BYE;
		send_exact(n->fd, &bye, 1);
		/* Half-close and drain until the peer's FIN. A bare close() here
		 * would RST: the peer streams inputs every frame, so our receive
		 * buffer is never empty, and close-with-unread-data vaporizes the
		 * BYE in flight -- the peer would see "vanished" instead of
		 * "left". The peer reads the BYE, quits, and closes through this
		 * same path, so its FIN normally lands within a frame or two; the
		 * cap only guards against a hung tab (a throttled background VM
		 * can starve for whole seconds, which is why a fixed short nap
		 * was not enough). */
		shutdown(n->fd, SHUT_WR);
		for (int spent_ms = 0; spent_ms < 5000; spent_ms += 100) {
			struct pollfd pfd = {n->fd, POLLIN, 0};
			int r = poll(&pfd, 1, 100);
			if (r < 0 && errno != EINTR) break;
			if (r > 0) {
				uint8_t junk[4096];
				if (recv(n->fd, junk, sizeof(junk), 0) <= 0) break;
			}
		}
		close(n->fd);
	}
	free(n->state_buf);
	free(n);
}

const char *net_describe(const net_t *n) {
	return n->describe_buf;
}
