/*
 * The console: load a ROM, run the machine at NTSC speed, paint the screen.
 *
 * The frame budget on an emulated i686 is the whole game here, so the loop
 * is honest about time: emulation runs every frame (game speed is sacred),
 * the *blit* is what gets skipped when the wall clock slips -- either on a
 * fixed cadence (--frameskip N) or automatically, never more than three
 * misses in a row so the screen stays alive.
 *
 * `--bench N` runs the core headless and reports fps against the 60.10 Hz
 * target; `--bench-video N` includes the video blit. Run both before
 * deciding frameskip on a new host.
 *
 * `nes host` / `nes join` bolt a second player on: net.c runs the
 * lockstep, this loop only swaps `agnes_set_input(in, NULL)` for the two
 * exchanged pads. The joiner brings no ROM -- it pulls ROM and machine
 * state from the host, so both cores start bit-identical. `nes list`
 * answers "who is hosting, and what" without joining anyone.
 */
#include "nes.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* One NTSC NES frame: 60.0988 Hz. */
#define FRAME_NS 16639267LL
#define MAX_CONSECUTIVE_SKIPS 3

static volatile sig_atomic_t g_signalled;

static void on_signal(int sig) {
	(void)sig;
	g_signalled = 1;
}

static long long now_ns(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void sleep_ns(long long ns) {
	if (ns <= 0) return;
	struct timespec ts = {(time_t)(ns / 1000000000LL), (long)(ns % 1000000000LL)};
	nanosleep(&ts, NULL);
}

static uint8_t *read_rom(const char *path, size_t *out_size) {
	FILE *f = fopen(path, "rb");
	if (!f) {
		fprintf(stderr, "nes: cannot open %s\n", path);
		return NULL;
	}
	fseek(f, 0, SEEK_END);
	long size = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (size < 16 || size > 8 * 1024 * 1024) {
		fprintf(stderr, "nes: %s does not look like an iNES ROM\n", path);
		fclose(f);
		return NULL;
	}
	uint8_t *data = malloc((size_t)size);
	if (!data || fread(data, 1, (size_t)size, f) != (size_t)size) {
		fprintf(stderr, "nes: short read on %s\n", path);
		fclose(f);
		free(data);
		return NULL;
	}
	fclose(f);
	*out_size = (size_t)size;
	return data;
}

static void usage(void) {
	printf(
	    "usage: nes ROM.nes [options]     play\n"
	    "       nes host ROM.nes [PORT]   host a 2P match; you are P1 (port 7777)\n"
	    "       nes join [IP[:PORT]]      join as P2 -- no ROM needed; a bare join\n"
	    "                                 scans the LAN (several hosts: a menu)\n"
	    "       nes list                  who is hosting on this LAN, and what\n"
	    "options:\n"
	    "  --frameskip N   blit every (N+1)th frame; -1 = automatic (default)\n"
	    "  --hold N        frames a serial keystroke holds a button (default 6)\n"
	    "  --lua FILE      init script (default: ./init.lua, then lua/init.lua)\n"
	    "  --no-sound      leave /dev/dsp alone\n"
	    "  --wav FILE      also dump the sound as a 22050 Hz mono WAV\n"
	    "  --bench N       run N frames headless, report fps\n"
	    "  --bench-video N same, including the framebuffer blit\n"
	    "  --delay N       netplay input delay in frames, 1..6 (default 3)\n"
	    "  --help, --version\n"
	    "keys: arrows/WASD move, K/X=A, J/Z=B, Enter=Start, Space=Select, q quits\n");
}

static int bench(agnes_t *agnes, const nes_config_t *cfg, const uint32_t palette[64]) {
	if (cfg->bench_video && !video_open()) return 1;
#ifdef NES_APU
	/* --bench --wav: no pacing, but the APU runs -- the off-target way to
	 * check that a ROM actually makes sound. */
	bool wav = cfg->wav_path && audio_open(false, cfg->wav_path);
#endif
	long long t0 = now_ns();
	for (long i = 0; i < cfg->bench_frames; i++) {
		if (!agnes_next_frame(agnes)) {
			fprintf(stderr, "nes: the core stopped at frame %ld\n", i);
			return 1;
		}
#ifdef NES_APU
		if (wav) {
			int n;
			const int16_t *s = apu_frame(agnes, &n);
			audio_write(s, n);
		}
#endif
		if (cfg->bench_video) video_blit(core_screen(agnes), palette);
	}
	long long dt = now_ns() - t0;
	double secs = (double)dt / 1e9;
	double fps = (double)cfg->bench_frames / secs;
	printf("%ld frames%s in %.2fs: %.1f fps (%.0f%% of 60.1)\n", cfg->bench_frames,
	       cfg->bench_video ? " (with blit)" : "", secs, fps, fps / 60.0988 * 100.0);
#ifdef NES_APU
	if (wav) {
		audio_close();
		printf("wav: %s\n", cfg->wav_path);
	}
#endif
	if (cfg->bench_video) video_close();
	return 0;
}

/* Is this argv entry a bare port number (for `nes host ROM [PORT]`)? */
static bool all_digits(const char *s) {
	if (!*s) return false;
	for (; *s; s++)
		if (*s < '0' || *s > '9') return false;
	return true;
}

static void print_hosts(FILE *to, const net_host_t *hosts, int n) {
	fprintf(to, "netplay: %d host%s on this LAN:\n", n, n == 1 ? "" : "s");
	bool any_self = false;
	for (int i = 0; i < n; i++) {
		fprintf(to, "  %c %-15s %s\n", hosts[i].self ? '*' : ' ', hosts[i].addr,
		        hosts[i].game);
		any_self |= hosts[i].self;
	}
	if (any_self) fprintf(to, "  (* this machine)\n");
}

/* `nes list`: scan and report, join nobody. */
static int list_hosts(int port) {
	printf("netplay: scanning the LAN...\n");
	fflush(stdout);
	net_host_t hosts[8];
	int n = net_discover(hosts, 8, port);
	if (n == 0) {
		fprintf(stderr, "nes: nobody is hosting -- someone runs `nes host GAME.nes` first\n");
		return 1;
	}
	print_hosts(stdout, hosts, n);
	printf("  (join one with `nes join IP`)\n");
	return 0;
}

int main(int argc, char **argv) {
	nes_config_t cfg = {0};
	cfg.frameskip = -1;
	cfg.hold_frames = 6;
	cfg.net_port = NET_DEFAULT_PORT;
	cfg.net_delay = 3;
	static char join_buf[64]; /* `nes join HOST:PORT`, split in place */

	/* The netplay verbs come first, bridge-style: `nes host ROM`,
	 * `nes join [IP]`, `nes list`. Everything after them parses as usual. */
	int argstart = 1;
	if (argc > 1 && strcmp(argv[1], "host") == 0) {
		cfg.net_mode = NET_HOST;
		argstart = 2;
	} else if (argc > 1 && strcmp(argv[1], "join") == 0) {
		cfg.net_mode = NET_JOIN;
		argstart = 2;
	} else if (argc > 1 && strcmp(argv[1], "list") == 0) {
		if (argc > 2) {
			usage();
			return 2;
		}
		return list_hosts(NET_DEFAULT_PORT);
	}

	for (int i = argstart; i < argc; i++) {
		const char *arg = argv[i];
		if (strcmp(arg, "--help") == 0 || strcmp(arg, "-h") == 0) {
			usage();
			return 0;
		} else if (strcmp(arg, "--version") == 0) {
			printf("nes %s (agnes %s)\n", NES_VERSION, AGNES_VERSION_STRING);
			return 0;
		} else if (strcmp(arg, "--frameskip") == 0 && i + 1 < argc) {
			cfg.frameskip = atoi(argv[++i]);
			cfg.cli_set |= NES_CLI_FRAMESKIP;
		} else if (strcmp(arg, "--hold") == 0 && i + 1 < argc) {
			cfg.hold_frames = atoi(argv[++i]);
			cfg.cli_set |= NES_CLI_HOLD;
		} else if (strcmp(arg, "--lua") == 0 && i + 1 < argc) {
			cfg.lua_path = argv[++i];
		} else if (strcmp(arg, "--no-sound") == 0) {
			cfg.no_sound = true;
		} else if (strcmp(arg, "--wav") == 0 && i + 1 < argc) {
			cfg.wav_path = argv[++i];
		} else if (strcmp(arg, "--bench") == 0 && i + 1 < argc) {
			cfg.bench_frames = atol(argv[++i]);
		} else if (strcmp(arg, "--bench-video") == 0 && i + 1 < argc) {
			cfg.bench_frames = atol(argv[++i]);
			cfg.bench_video = true;
		} else if (strcmp(arg, "--delay") == 0 && i + 1 < argc) {
			cfg.net_delay = atoi(argv[++i]);
			if (cfg.net_delay < 1 || cfg.net_delay > NET_MAX_DELAY) {
				fprintf(stderr, "nes: --delay wants 1..%d\n", NET_MAX_DELAY);
				return 2;
			}
		} else if (arg[0] == '-') {
			fprintf(stderr, "nes: unknown option %s\n", arg);
			usage();
			return 2;
		} else if (cfg.net_mode == NET_JOIN) {
			/* The joiner's one positional argument is IP[:PORT]. */
			snprintf(join_buf, sizeof(join_buf), "%s", arg);
			char *colon = strchr(join_buf, ':');
			if (colon) {
				*colon = '\0';
				cfg.net_port = atoi(colon + 1);
			}
			cfg.net_addr = join_buf;
		} else if (cfg.net_mode == NET_HOST && all_digits(arg)) {
			cfg.net_port = atoi(arg);
		} else {
			cfg.rom_path = arg;
		}
	}
	if (cfg.net_mode != NET_OFF && cfg.bench_frames > 0) {
		fprintf(stderr, "nes: netplay and --bench don't mix\n");
		return 2;
	}
	if (cfg.net_mode != NET_JOIN && !cfg.rom_path) {
		usage();
		return 2;
	}

	/* A bare `nes join`: scan, and only auto-pick when the answer is
	 * unambiguous. Several hosts make a menu, not a coin toss. */
	if (cfg.net_mode == NET_JOIN && !cfg.net_addr) {
		printf("netplay: looking for a host on the LAN...\n");
		fflush(stdout);
		net_host_t hosts[8];
		int n = net_discover(hosts, 8, cfg.net_port);
		if (n == 0) {
			fprintf(stderr,
			        "nes: no host answered -- is `nes host GAME.nes` running on "
			        "this LAN?\n");
			return 1;
		}
		/* Every answer being our own machine (a backgrounded `nes host`
		 * here) is not a match waiting to happen -- say so instead of
		 * connecting to ourselves or offering a menu of mirrors. */
		bool all_self = true;
		for (int i = 0; i < n; i++) all_self = all_self && hosts[i].self;
		/* Fits an 80-column console in one line. */
		if (all_self) {
			fprintf(stderr, "nes: the only host on this LAN is this machine -- "
			                "a match needs somebody else\n");
			return 1;
		}
		if (n > 1) {
			print_hosts(stderr, hosts, n);
			fprintf(stderr, "pick one: nes join IP\n");
			return 1;
		}
		printf("netplay: found %s playing %s\n", hosts[0].addr, hosts[0].game);
		snprintf(join_buf, sizeof(join_buf), "%s", hosts[0].addr);
		cfg.net_addr = join_buf;
	}

	/* The joiner's ROM comes over the wire -- connect before the core. */
	net_t *net = NULL;
	size_t rom_size = 0;
	uint8_t *rom;
	if (cfg.net_mode == NET_JOIN) {
		net = net_join_begin(cfg.net_addr, cfg.net_port, cfg.hold_frames);
		if (!net) return 1;
		rom = net_join_rom(net, &rom_size);
		if (!rom) {
			net_close(net);
			return 1;
		}
	} else {
		rom = read_rom(cfg.rom_path, &rom_size);
		if (!rom) return 1;
	}

	agnes_t *agnes = agnes_make();
	if (!agnes || !agnes_load_ines_data(agnes, rom, rom_size)) {
		int mapper = rom_size >= 8 ? ((rom[6] >> 4) | (rom[7] & 0xf0)) : -1;
		fprintf(stderr,
		        "nes: could not load %s -- mapper %d? agnes supports 0 (NROM), "
		        "1 (MMC1), 2 (UxROM) and 4 (MMC3)\n",
		        cfg.rom_path ? cfg.rom_path : "the host's ROM", mapper);
		return 1;
	}

	uint32_t palette[64];
	core_palette_bgrx(palette);

#ifdef NES_APU
	apu_init();
#endif

	if (cfg.bench_frames > 0) return bench(agnes, &cfg, palette);

	/* Netplay rendezvous before the mode-set: "waiting for P2" belongs on
	 * the terminal, not on a black game screen. The state ships before
	 * either side's init.lua runs; both sides run their own copy, and the
	 * frame-0 CRC exchange catches any difference immediately. */
	if (cfg.net_mode == NET_HOST) {
		const char *base = strrchr(cfg.rom_path, '/');
		net = net_host_wait(cfg.net_port, cfg.net_delay, cfg.hold_frames,
		                    base ? base + 1 : cfg.rom_path);
		if (!net) return 1;
		if (!net_host_start(net, rom, rom_size, agnes)) {
			net_close(net);
			return 1;
		}
	} else if (cfg.net_mode == NET_JOIN) {
		if (!net_join_state(net, agnes)) {
			net_close(net);
			return 1;
		}
	}

#ifdef NES_LUA
	if (!script_open(agnes, &cfg)) return 1;
#endif

	if (!video_open()) return 1;

	input_open();

	bool sound = false;
#ifdef NES_APU
	sound = audio_open(!cfg.no_sound, cfg.wav_path);
#endif

	/* input_open only probes and flips the tty; stdout still prints fine. */
	printf("nes %s: %s\n", NES_VERSION, cfg.rom_path ? cfg.rom_path : "(ROM from the host)");
	if (net) printf("netplay: %s\n", net_describe(net));
	printf("screen %s -- open the footer's screen panel to watch\n", video_describe());
	printf("input: %s -- click the screen panel to use it as a gamepad\n", input_describe());
#ifdef NES_APU
	printf("sound: %s\n", audio_describe());
#endif
	printf("keys: arrows/WASD move, K/X=A, J/Z=B, Enter=Start, Space=Select, q quits\n");
#ifdef NES_LUA
	printf("control fifo: echo 'lua...' > /tmp/nes.ctl\n");
#endif
	fflush(stdout);

	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);

	unsigned long frame = 0;
	unsigned long blits = 0;
	int consecutive_skips = 0;
	bool quit = false;
	long long start = now_ns();

	while (!quit && !g_signalled) {
		agnes_input_t in = {0};
		input_poll(&in, &quit, cfg.hold_frames);
#ifdef NES_LUA
		script_frame(&in, frame, &quit);
#endif
		if (net) {
			/* Lockstep: `in` is only a promise for frame N+delay; what
			 * the core eats now is what both sides agreed on for N. */
			agnes_input_t p1, p2;
			if (!net_exchange(net, &in, &quit, &p1, &p2)) break;
			agnes_set_input(agnes, &p1, &p2);
		} else {
			agnes_set_input(agnes, &in, NULL);
		}
		if (!agnes_next_frame(agnes)) {
			fprintf(stderr, "\r\nnes: the core stopped\r\n");
			break;
		}

#ifdef NES_APU
		if (sound) {
			/* When /dev/dsp is live this write blocks once its ~93 ms
			 * buffer fills -- the audio clock paces the whole loop. */
			int nsamples;
			const int16_t *samples = apu_frame(agnes, &nsamples);
			audio_write(samples, nsamples);
		}
#endif

		bool blit;
		long long deadline = start + (long long)(frame + 1) * FRAME_NS;
		if (cfg.frameskip >= 0) {
			blit = frame % (unsigned long)(cfg.frameskip + 1) == 0;
		} else {
			/* Behind the clock: drop the blit, but never go dark. */
			blit = now_ns() <= deadline || consecutive_skips >= MAX_CONSECUTIVE_SKIPS;
		}
		if (blit) {
			video_blit(core_screen(agnes), palette);
			blits++;
			consecutive_skips = 0;
		} else {
			consecutive_skips++;
		}

		/* The nanosleep pacer stays even with audio: before the DSP buffer
		 * fills (or if the device drops out) it is still what holds 60 fps.
		 * Once audio blocks, `late` hovers near zero and this no-ops. */
		long long late = now_ns() - deadline;
		if (late < 0) {
			sleep_ns(-late);
		} else if (late > 250000000LL) {
			start += late; /* forgive a stall instead of sprinting after it */
		}
		frame++;
	}

	net_close(net); /* waves the peer goodbye so it exits cleanly too */
	input_close();
	video_close();
#ifdef NES_APU
	audio_close();
#endif
#ifdef NES_LUA
	script_close();
#endif

	double secs = (double)(now_ns() - start) / 1e9;
	printf("\nnes: %lu frames (%lu blits) in %.1fs -- %.1f fps\n", frame, blits, secs,
	       secs > 0 ? (double)frame / secs : 0.0);
	free(rom); /* agnes borrowed it until now */
	return 0;
}
