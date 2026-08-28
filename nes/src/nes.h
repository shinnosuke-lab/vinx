/*
 * The shared surface between the modules of the vinx NES machine.
 *
 * One binary, four translation units: core.c (the vendored agnes core plus
 * accessors into its internals), video.c (the DRM head, mode-set to the
 * game's picture), input.c (evdev with a serial fallback) and main.c (the
 * loop). lua_glue.c joins when the build defines NES_LUA (the default in
 * the guest, where liblua ships).
 */
#ifndef NES_NES_H
#define NES_NES_H

#include <stdbool.h>
#include <stdint.h>

#include "../vendor/agnes.h"

/* Bumped on changes that could break netplay determinism or its protocol:
 * the handshake refuses a peer whose NES_VERSION differs. */
#define NES_VERSION "0.3.0"

/* Which of these the command line set explicitly -- init.lua fills the rest. */
enum {
	NES_CLI_FRAMESKIP = 1 << 0,
	NES_CLI_HOLD = 1 << 1,
};

typedef struct {
	const char *rom_path;
	const char *lua_path; /* init script; NULL = ./init.lua, then lua/init.lua */
	const char *wav_path; /* --wav: dump the APU output as a WAV file */
	long bench_frames;    /* >0: run headless and report fps */
	bool bench_video;     /* bench with the video blit included */
	bool no_sound;        /* --no-sound: leave /dev/dsp alone */
	int frameskip;        /* -1 = auto; N = blit every (N+1)th frame */
	int hold_frames;      /* how long one serial keystroke holds a button */
	unsigned cli_set;     /* NES_CLI_* bits */
	int net_mode;         /* NET_OFF / NET_HOST / NET_JOIN */
	const char *net_addr; /* join target; NULL = discover, then auto-pick or menu */
	int net_port;         /* TCP and discovery port (default NET_DEFAULT_PORT) */
	int net_delay;        /* lockstep input delay in frames (1..6) */
} nes_config_t;

/* ── core.c ── */

/* 256*240 palette indices (agnes's own screen buffer, valid after a frame). */
const uint8_t *core_screen(const agnes_t *agnes);
/* The NES palette as the scanout wants it: XRGB little-endian words. */
void core_palette_bgrx(uint32_t out[64]);
/* CPU bus access, for cheats and bots. Reads of $2002-range PPU registers
 * have side effects, like on the real machine -- RAM ($0000-$07FF) and
 * cartridge RAM ($6000-$7FFF) are the safe playground. */
uint8_t core_bus_read(agnes_t *agnes, uint16_t addr);
void core_bus_write(agnes_t *agnes, uint16_t addr, uint8_t val);
/* The CPU's monotonic cycle counter -- the APU's timeline. */
uint64_t core_cycles(const agnes_t *agnes);

/* ── apu.c (NES_APU builds; every Makefile target defines it) ── */

#define NES_AUDIO_RATE 22050 /* Hz, s16 mono */

void apu_init(void);
/* Replay this frame's register writes and synthesize its samples (366-367
 * of them). Call once per agnes_next_frame; the buffer is reused. */
const int16_t *apu_frame(agnes_t *agnes, int *out_samples);
/* The taps the vendored core calls (see vendor/VENDOR.txt). */
void nes_apu_reg_write(agnes_t *agnes, uint16_t addr, uint8_t val, uint64_t cycles);
uint8_t nes_apu_reg_read_4015(agnes_t *agnes, uint64_t cycles);
/* Netplay ships the APU beside the agnes state: $4015 reads feed the CPU,
 * so both machines' length counters must match bit for bit. Plain memcpy
 * of the module's whole state -- the same binary regenerates the same
 * lookup tables, so they travel harmlessly. */
size_t apu_state_size(void);
void apu_dump_state(void *out);
void apu_restore_state(const void *in);

/* ── audio.c ── */

/* Open /dev/dsp (when want_dsp) and/or a WAV dump; false = no sink at all.
 * Both failures are quiet downgrades, never fatal. */
bool audio_open(bool want_dsp, const char *wav_path);
bool audio_live(void); /* dsp is open: its blocking writes pace the loop */
void audio_write(const int16_t *samples, int n);
void audio_close(void);
const char *audio_describe(void); /* "on (/dev/dsp 22050 Hz)", "wav", "off" */

/* ── video.c ── */

/* Mode-set the DRM head to the visible picture (256x224: overscan cropped)
 * and mmap the scanout buffer; false if the head is unusable. Closing (or
 * dying) restores fbcon -- the kernel's lastclose does it. */
bool video_open(void);
void video_close(void);
/* Palette-map one 256x240 agnes frame into the scanout, minus overscan. */
void video_blit(const uint8_t *indices, const uint32_t palette[64]);
const char *video_describe(void); /* "256x224 native (the page scales it)" */

/* ── input.c ── */

bool input_open(void);
void input_close(void);
/* Poll both backends, decay serial holds, merge into `out`. */
void input_poll(agnes_input_t *out, bool *quit, int hold_frames);
const char *input_describe(void); /* "evdev+serial" or "serial" */

/* ── net.c (netplay: 2-player lockstep over the bridged LAN) ── */

enum { NET_OFF = 0, NET_HOST, NET_JOIN };

#define NET_DEFAULT_PORT 7777
#define NET_MAX_DELAY 6
#define NET_GAME_NAME_MAX 32

/* One discovered host, as its NESA answer named it. */
typedef struct {
	char addr[16];                    /* dotted quad */
	char game[NET_GAME_NAME_MAX + 1]; /* ROM basename; "?" if unnamed */
	bool self;                        /* answered from one of our own addresses */
} net_host_t;

typedef struct net net_t;

/* One LAN scan: probe (broadcast + /24 unicast sweep), collect every answer
 * in the window, dedupe by address. Returns how many landed in out[]. */
int net_discover(net_host_t *out, int max, int port);

/* Host: listen on :port (TCP for the match, UDP for discovery probes),
 * print the copyable join line, block until a peer arrives and handshakes.
 * rom_name is what discovery answers advertise. NULL on failure. */
net_t *net_host_wait(int port, int delay, int hold_frames, const char *rom_name);
/* Host: push the ROM and the machine state to the peer; lockstep starts
 * on the next net_exchange. */
bool net_host_start(net_t *n, const uint8_t *rom, size_t rom_size, agnes_t *agnes);

/* Joiner: connect and handshake. The caller resolves a bare `nes join`
 * into an address first (net_discover) -- picking between several hosts
 * is a menu for the user, not this module's coin toss. */
net_t *net_join_begin(const char *host, int port, int hold_frames);
/* Joiner: the host's ROM (malloc'd; agnes borrows it -- keep it alive). */
uint8_t *net_join_rom(net_t *n, size_t *out_size);
/* Joiner: apply the host's machine state to the freshly loaded core. */
bool net_join_state(net_t *n, agnes_t *agnes);

/* One frame of lockstep: promise `local` for frame N+delay, wait for the
 * peer's frame-N input, hand back both pads (host drives P1). Every 60
 * frames the sides swap state CRCs; on a mismatch the host pushes a fresh
 * state and the match continues. False = match over (peer left or link
 * died) -- the caller should quit its loop. */
bool net_exchange(net_t *n, const agnes_input_t *local, bool *quit, agnes_input_t *p1,
                  agnes_input_t *p2);
void net_close(net_t *n);
const char *net_describe(const net_t *n); /* "P1 (host) on :7777" ... */

/* ── lua_glue.c (NES_LUA builds only) ── */

#ifdef NES_LUA
bool script_open(agnes_t *agnes, nes_config_t *cfg);
/* Run queued /tmp/nes.ctl lines and the on_frame hook; may edit the input. */
void script_frame(agnes_input_t *inout, unsigned long frame, bool *quit);
void script_close(void);
#endif

#endif /* NES_NES_H */
