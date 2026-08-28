/*
 * The 2A03 APU that agnes never had: two pulses, triangle, noise, DMC.
 *
 * The core emulates a frame at a time, so the APU does too. Register writes
 * are tapped inside the vendored bus dispatcher (see vendor/VENDOR.txt) and
 * queued with their CPU-cycle stamp; at frame end apu_frame() replays the
 * queue in order while synthesizing that frame's worth of samples
 * (blargg-style catch-up). Channels follow the NESdev wiki; mixing is the
 * standard non-linear formula, precomputed into lookup tables.
 *
 * Two honest omissions, both noted in the README: the frame counter never
 * raises an IRQ, and $4015 reads report length counters as of the previous
 * frame boundary (the synth hasn't caught up yet when the CPU asks).
 */
#include "nes.h"

#include <string.h>

#define RATE NES_AUDIO_RATE /* 22050 */
#define CPU_HZ 1789773
#define NOMINAL_FRAME_CYCLES 29781 /* CPU_HZ / 60.0988 */

/* Samples per frame as an exact fraction: RATE / 60.0988 Hz. */
#define FPS_X10K 600988
#define SPF_NUM ((long long)RATE * 10000)

#define QUEUE_LEN 1024
#define MAX_SAMPLES 512

/* ── tables (NESdev, NTSC) ── */

static const uint8_t duty_tab[4][8] = {
    {0, 1, 0, 0, 0, 0, 0, 0},
    {0, 1, 1, 0, 0, 0, 0, 0},
    {0, 1, 1, 1, 1, 0, 0, 0},
    {1, 0, 0, 1, 1, 1, 1, 1},
};

static const uint8_t length_tab[32] = {
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
};

static const uint16_t noise_period_tab[16] = {
    4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
};

static const uint16_t dmc_rate_tab[16] = {
    428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
};

/* ── channel state ── */

typedef struct { /* envelope unit, shared by the pulses and noise */
	bool start;
	uint8_t divider, decay;
} env_t;

typedef struct {
	uint8_t duty, vol; /* vol doubles as the envelope divider period */
	bool halt, constant;
	bool sw_enable, sw_negate, sw_reload;
	uint8_t sw_period, sw_shift, sw_div;
	uint16_t timer; /* 11-bit period */
	uint32_t acc;   /* CPU cycles toward the next sequencer step */
	uint8_t seq;    /* 0..7 */
	uint8_t length;
	bool enabled;
	env_t env;
	bool ones_complement; /* pulse 1's sweep-negate quirk */
} pulse_t;

typedef struct {
	bool control; /* halts length, holds linear */
	uint8_t lin_reload_val, lin;
	bool lin_reload;
	uint16_t timer;
	uint32_t acc;
	uint8_t seq; /* 0..31 */
	uint8_t length;
	bool enabled;
} tri_t;

typedef struct {
	bool halt, constant;
	uint8_t vol;
	bool mode;
	uint16_t period; /* CPU cycles per LFSR shift */
	uint32_t acc;
	uint16_t lfsr;
	uint8_t length;
	bool enabled;
	env_t env;
} noise_t;

typedef struct {
	bool loop;
	uint16_t rate; /* CPU cycles per output bit */
	uint32_t acc;
	uint8_t output; /* 7-bit DAC level */
	uint16_t sample_addr, sample_len;
	uint16_t cur_addr, bytes_left;
	uint8_t shift, bits_left;
	bool silence, buffer_full;
	uint8_t buffer;
} dmc_t;

typedef struct {
	uint64_t cyc;
	uint16_t addr;
	uint8_t val;
} wr_t;

static struct {
	pulse_t p1, p2;
	tri_t tri;
	noise_t noi;
	dmc_t dmc;

	int fs_mode; /* 0 = 4-step, 1 = 5-step */
	uint32_t fs_time;
	int fs_step;

	wr_t q[QUEUE_LEN];
	int q_head, q_count;

	uint64_t last_cycles; /* CPU cycle stamp of the previous frame boundary */
	long long spf_acc;    /* fractional samples-per-frame accumulator */
	uint32_t cps_acc;     /* fractional cycles-per-sample accumulator */

	float hp_in, hp_out; /* one-pole high-pass (kills the mixer's DC) */
	float pulse_lut[31], tnd_lut[203];
	int16_t buf[MAX_SAMPLES];
} A;

/* ── units ── */

static void env_clock(env_t *e, bool loop, uint8_t period) {
	if (e->start) {
		e->start = false;
		e->decay = 15;
		e->divider = period;
		return;
	}
	if (e->divider) {
		e->divider--;
		return;
	}
	e->divider = period;
	if (e->decay)
		e->decay--;
	else if (loop)
		e->decay = 15;
}

static int pulse_target(const pulse_t *p) {
	int change = p->timer >> p->sw_shift;
	if (p->sw_negate) return (int)p->timer - change - (p->ones_complement ? 1 : 0);
	return (int)p->timer + change;
}

static void sweep_clock(pulse_t *p) {
	int target = pulse_target(p);
	bool mute = p->timer < 8 || target > 0x7ff;
	if (p->sw_div == 0 && p->sw_enable && p->sw_shift && !mute && target >= 0)
		p->timer = (uint16_t)target;
	if (p->sw_div == 0 || p->sw_reload) {
		p->sw_div = p->sw_period;
		p->sw_reload = false;
	} else {
		p->sw_div--;
	}
}

static void quarter_clock(void) {
	env_clock(&A.p1.env, A.p1.halt, A.p1.vol);
	env_clock(&A.p2.env, A.p2.halt, A.p2.vol);
	env_clock(&A.noi.env, A.noi.halt, A.noi.vol);
	if (A.tri.lin_reload)
		A.tri.lin = A.tri.lin_reload_val;
	else if (A.tri.lin)
		A.tri.lin--;
	if (!A.tri.control) A.tri.lin_reload = false;
}

static void half_clock(void) {
	if (!A.p1.halt && A.p1.length) A.p1.length--;
	if (!A.p2.halt && A.p2.length) A.p2.length--;
	if (!A.tri.control && A.tri.length) A.tri.length--;
	if (!A.noi.halt && A.noi.length) A.noi.length--;
	sweep_clock(&A.p1);
	sweep_clock(&A.p2);
}

/* NTSC frame sequencer: quarter clocks at every listed point, half clocks
 * at the 2nd and 4th. Mode 1's silent 29829 step is simply not listed. */
static void fs_advance(uint32_t n) {
	static const uint32_t t4[4] = {7457, 14913, 22371, 29829};
	static const uint32_t t5[4] = {7457, 14913, 22371, 37281};
	A.fs_time += n;
	for (;;) {
		const uint32_t *tab = A.fs_mode ? t5 : t4;
		uint32_t period = A.fs_mode ? 37282u : 29830u;
		if (A.fs_step < 4 && A.fs_time >= tab[A.fs_step]) {
			quarter_clock();
			if (A.fs_step == 1 || A.fs_step == 3) half_clock();
			A.fs_step++;
			continue;
		}
		if (A.fs_time >= period) {
			A.fs_time -= period;
			A.fs_step = 0;
			continue;
		}
		break;
	}
}

/* ── channel timers, advanced n CPU cycles at a time ── */

static void pulse_advance(pulse_t *p, uint32_t n) {
	uint32_t period = ((uint32_t)p->timer + 1) * 2;
	p->acc += n;
	p->seq = (uint8_t)((p->seq + p->acc / period) & 7);
	p->acc %= period;
}

static int pulse_out(const pulse_t *p) {
	if (!p->length || p->timer < 8) return 0;
	if (pulse_target(p) > 0x7ff) return 0;
	if (!duty_tab[p->duty][p->seq]) return 0;
	return p->constant ? p->vol : p->env.decay;
}

static void tri_advance(tri_t *t, uint32_t n) {
	if (!t->length || !t->lin) return; /* gated: sequencer holds its value */
	if (t->timer < 2) return;          /* ultrasonic on hardware; would alias here */
	uint32_t period = (uint32_t)t->timer + 1;
	t->acc += n;
	t->seq = (uint8_t)((t->seq + t->acc / period) & 31);
	t->acc %= period;
}

static int tri_out(const tri_t *t) {
	return t->seq < 16 ? 15 - t->seq : t->seq - 16;
}

static void noise_advance(noise_t *nz, uint32_t n) {
	nz->acc += n;
	while (nz->acc >= nz->period) {
		nz->acc -= nz->period;
		uint16_t fb = (nz->lfsr ^ (nz->lfsr >> (nz->mode ? 6 : 1))) & 1;
		nz->lfsr = (uint16_t)((nz->lfsr >> 1) | (fb << 14));
	}
}

static int noise_out(const noise_t *nz) {
	if (!nz->length || (nz->lfsr & 1)) return 0;
	return nz->constant ? nz->vol : nz->env.decay;
}

/* DMC sample bytes come over the CPU bus at synth time. Addresses only
 * ever land in $8000-$FFFF (0xC000 + 64*n, wrapping to $8000), which is
 * cartridge ROM through the mapper: side-effect free. */
static void dmc_refill(agnes_t *agnes, dmc_t *d) {
	if (!d->bytes_left) return;
	d->buffer = core_bus_read(agnes, d->cur_addr);
	d->buffer_full = true;
	d->cur_addr = d->cur_addr == 0xffff ? 0x8000 : (uint16_t)(d->cur_addr + 1);
	d->bytes_left--;
	if (!d->bytes_left && d->loop) {
		d->cur_addr = d->sample_addr;
		d->bytes_left = d->sample_len;
	}
}

static void dmc_advance(agnes_t *agnes, dmc_t *d, uint32_t n) {
	d->acc += n;
	while (d->acc >= d->rate) {
		d->acc -= d->rate;
		if (d->bits_left == 0) {
			d->bits_left = 8;
			if (d->buffer_full) {
				d->silence = false;
				d->shift = d->buffer;
				d->buffer_full = false;
				dmc_refill(agnes, d);
			} else {
				d->silence = true;
			}
		}
		if (!d->silence) {
			if (d->shift & 1) {
				if (d->output <= 125) d->output += 2;
			} else {
				if (d->output >= 2) d->output -= 2;
			}
			d->shift >>= 1;
		}
		d->bits_left--;
	}
}

/* ── register writes, applied on the synth timeline ── */

static void reg_apply(agnes_t *agnes, uint16_t addr, uint8_t val) {
	pulse_t *p = (addr & 0x4) ? &A.p2 : &A.p1;
	switch (addr) {
	case 0x4000:
	case 0x4004:
		p->duty = val >> 6;
		p->halt = val & 0x20;
		p->constant = val & 0x10;
		p->vol = val & 15;
		break;
	case 0x4001:
	case 0x4005:
		p->sw_enable = val & 0x80;
		p->sw_period = (val >> 4) & 7;
		p->sw_negate = val & 0x08;
		p->sw_shift = val & 7;
		p->sw_reload = true;
		break;
	case 0x4002:
	case 0x4006:
		p->timer = (uint16_t)((p->timer & 0x700) | val);
		break;
	case 0x4003:
	case 0x4007:
		p->timer = (uint16_t)((p->timer & 0xff) | ((val & 7) << 8));
		if (p->enabled) p->length = length_tab[val >> 3];
		p->seq = 0;
		p->env.start = true;
		break;
	case 0x4008:
		A.tri.control = val & 0x80;
		A.tri.lin_reload_val = val & 0x7f;
		break;
	case 0x400a:
		A.tri.timer = (uint16_t)((A.tri.timer & 0x700) | val);
		break;
	case 0x400b:
		A.tri.timer = (uint16_t)((A.tri.timer & 0xff) | ((val & 7) << 8));
		if (A.tri.enabled) A.tri.length = length_tab[val >> 3];
		A.tri.lin_reload = true;
		break;
	case 0x400c:
		A.noi.halt = val & 0x20;
		A.noi.constant = val & 0x10;
		A.noi.vol = val & 15;
		break;
	case 0x400e:
		A.noi.mode = val & 0x80;
		A.noi.period = noise_period_tab[val & 15];
		break;
	case 0x400f:
		if (A.noi.enabled) A.noi.length = length_tab[val >> 3];
		A.noi.env.start = true;
		break;
	case 0x4010:
		A.dmc.loop = val & 0x40; /* IRQ enable bit ignored: no frame/DMC IRQs */
		A.dmc.rate = dmc_rate_tab[val & 15];
		break;
	case 0x4011:
		A.dmc.output = val & 0x7f;
		break;
	case 0x4012:
		A.dmc.sample_addr = (uint16_t)(0xc000 + val * 64);
		break;
	case 0x4013:
		A.dmc.sample_len = (uint16_t)(val * 16 + 1);
		break;
	case 0x4015:
		A.p1.enabled = val & 0x01;
		A.p2.enabled = val & 0x02;
		A.tri.enabled = val & 0x04;
		A.noi.enabled = val & 0x08;
		if (!A.p1.enabled) A.p1.length = 0;
		if (!A.p2.enabled) A.p2.length = 0;
		if (!A.tri.enabled) A.tri.length = 0;
		if (!A.noi.enabled) A.noi.length = 0;
		if (val & 0x10) {
			if (!A.dmc.bytes_left) {
				A.dmc.cur_addr = A.dmc.sample_addr;
				A.dmc.bytes_left = A.dmc.sample_len;
			}
			if (!A.dmc.buffer_full) dmc_refill(agnes, &A.dmc);
		} else {
			A.dmc.bytes_left = 0;
		}
		break;
	case 0x4017:
		A.fs_mode = (val & 0x80) ? 1 : 0;
		A.fs_time = 0;
		A.fs_step = 0;
		if (A.fs_mode) { /* 5-step mode clocks everything immediately */
			quarter_clock();
			half_clock();
		}
		break;
	default: /* $4009, $400d, $4014, $4016 never reach us; ignore the rest */
		break;
	}
}

/* ── the hooks the vendored core calls (see vendor/VENDOR.txt) ── */

void nes_apu_reg_write(agnes_t *agnes, uint16_t addr, uint8_t val, uint64_t cycles) {
	(void)agnes;
	if (A.q_count == QUEUE_LEN) { /* only if nobody drains us (bench w/o wav) */
		A.q_head = (A.q_head + 1) % QUEUE_LEN;
		A.q_count--;
	}
	wr_t *w = &A.q[(A.q_head + A.q_count) % QUEUE_LEN];
	w->cyc = cycles;
	w->addr = addr;
	w->val = val;
	A.q_count++;
}

uint8_t nes_apu_reg_read_4015(agnes_t *agnes, uint64_t cycles) {
	(void)agnes;
	(void)cycles;
	/* As of the last frame boundary -- the synth hasn't caught up yet. */
	uint8_t r = 0;
	if (A.p1.length) r |= 0x01;
	if (A.p2.length) r |= 0x02;
	if (A.tri.length) r |= 0x04;
	if (A.noi.length) r |= 0x08;
	if (A.dmc.bytes_left) r |= 0x10;
	return r;
}

/* ── public interface ── */

/* The whole module state as one blob (see nes.h for why netplay needs it).
 * `buf` is per-frame scratch and the LUTs are identical across the same
 * binary, so shipping them costs a few KB and saves a second struct. */
size_t apu_state_size(void) {
	return sizeof(A);
}

void apu_dump_state(void *out) {
	memcpy(out, &A, sizeof(A));
}

void apu_restore_state(const void *in) {
	memcpy(&A, in, sizeof(A));
}

void apu_init(void) {
	memset(&A, 0, sizeof(A));
	A.p1.ones_complement = true;
	A.noi.lfsr = 1;
	A.noi.period = noise_period_tab[0];
	A.dmc.rate = dmc_rate_tab[0];
	for (int i = 1; i <= 30; i++) A.pulse_lut[i] = 95.52f / (8128.0f / (float)i + 100.0f);
	for (int i = 1; i <= 202; i++) A.tnd_lut[i] = 163.67f / (24329.0f / (float)i + 100.0f);
}

const int16_t *apu_frame(agnes_t *agnes, int *out_samples) {
	uint64_t now = core_cycles(agnes);
	uint64_t span = now > A.last_cycles ? now - A.last_cycles : 0;
	/* A save-state load (or the very first frame) breaks monotonicity;
	 * fall back to landing every queued write on sample 0. */
	if (span > 3 * NOMINAL_FRAME_CYCLES) span = 0;

	A.spf_acc += SPF_NUM;
	int n = (int)(A.spf_acc / FPS_X10K); /* 366 or 367 */
	A.spf_acc %= FPS_X10K;
	if (n > MAX_SAMPLES) n = MAX_SAMPLES;

	for (int s = 0; s < n; s++) {
		/* Writes stamped inside this slice of the frame land here. */
		while (A.q_count) {
			wr_t *w = &A.q[A.q_head];
			int idx = 0;
			if (span && w->cyc > A.last_cycles)
				idx = (int)((w->cyc - A.last_cycles) * (uint64_t)n / span);
			if (idx > s) break;
			reg_apply(agnes, w->addr, w->val);
			A.q_head = (A.q_head + 1) % QUEUE_LEN;
			A.q_count--;
		}

		A.cps_acc += CPU_HZ;
		uint32_t cyc = A.cps_acc / RATE; /* 81 or 82 CPU cycles */
		A.cps_acc %= RATE;

		fs_advance(cyc);
		pulse_advance(&A.p1, cyc);
		pulse_advance(&A.p2, cyc);
		tri_advance(&A.tri, cyc);
		noise_advance(&A.noi, cyc);
		dmc_advance(agnes, &A.dmc, cyc);

		float mix = A.pulse_lut[pulse_out(&A.p1) + pulse_out(&A.p2)] +
		            A.tnd_lut[3 * tri_out(&A.tri) + 2 * noise_out(&A.noi) + A.dmc.output];
		float y = mix - A.hp_in + 0.995f * A.hp_out;
		A.hp_in = mix;
		A.hp_out = y;
		int v = (int)(y * 32000.0f);
		if (v > 32767) v = 32767;
		if (v < -32768) v = -32768;
		A.buf[s] = (int16_t)v;
	}

	/* Writes stamped at the very tail of the frame round up past n-1. */
	while (A.q_count) {
		wr_t *w = &A.q[A.q_head];
		reg_apply(agnes, w->addr, w->val);
		A.q_head = (A.q_head + 1) % QUEUE_LEN;
		A.q_count--;
	}

	A.last_cycles = now;
	*out_samples = n;
	return A.buf;
}
