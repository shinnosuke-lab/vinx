/*
 * Where the APU's samples go: /dev/dsp, a WAV file, or both.
 *
 * /dev/dsp is OSS -- the guest kernel wraps its SB16 driver in the OSS
 * emulation layer, and v86 feeds that straight into the browser's
 * AudioContext. The blocking write is the whole pacing story: once the
 * (deliberately small) DSP buffer fills, write() returns at exactly the
 * consumption rate, so the main loop locks to the audio clock instead of
 * nanosleep. The ioctl numbers are spelled out below because the guest's
 * tcc only has musl headers, no <linux/soundcard.h>; they are frozen ABI.
 *
 * The WAV sink (--wav) exists so the APU can be verified off-target: run
 * with --bench and inspect the file on the host.
 */
#include "nes.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#define SNDCTL_DSP_SPEED 0xc0045002
#define SNDCTL_DSP_SETFMT 0xc0045005
#define SNDCTL_DSP_CHANNELS 0xc0045006
#define SNDCTL_DSP_SETFRAGMENT 0xc004500a
#define AFMT_S16_LE 0x00000010

static int g_dsp = -1;
static FILE *g_wav;
static long g_wav_samples;
static char g_desc[48] = "off";

/* 44-byte canonical header; the two sizes get patched on close. */
static void wav_header(FILE *f, uint32_t nsamples) {
	uint32_t data_bytes = nsamples * 2;
	uint32_t riff = 36 + data_bytes;
	uint32_t rate = NES_AUDIO_RATE, byte_rate = rate * 2;
	uint16_t fmt = 1, channels = 1, block = 2, bits = 16;
	uint32_t fmt_size = 16;
	fwrite("RIFF", 1, 4, f);
	fwrite(&riff, 4, 1, f);
	fwrite("WAVEfmt ", 1, 8, f);
	fwrite(&fmt_size, 4, 1, f);
	fwrite(&fmt, 2, 1, f);
	fwrite(&channels, 2, 1, f);
	fwrite(&rate, 4, 1, f);
	fwrite(&byte_rate, 4, 1, f);
	fwrite(&block, 2, 1, f);
	fwrite(&bits, 2, 1, f);
	fwrite("data", 1, 4, f);
	fwrite(&data_bytes, 4, 1, f);
}

static bool dsp_open(void) {
	int fd = open("/dev/dsp", O_WRONLY);
	if (fd < 0) return false;
	/* Small buffer: 4 fragments x 1024 bytes = ~93 ms. Latency, and no
	 * multi-second video sprint while an empty buffer soaks up writes. */
	int frag = 0x0004000a;
	ioctl(fd, SNDCTL_DSP_SETFRAGMENT, &frag); /* best effort */
	int fmt = AFMT_S16_LE, ch = 1, speed = NES_AUDIO_RATE;
	if (ioctl(fd, SNDCTL_DSP_SETFMT, &fmt) < 0 || fmt != AFMT_S16_LE ||
	    ioctl(fd, SNDCTL_DSP_CHANNELS, &ch) < 0 || ch != 1 ||
	    ioctl(fd, SNDCTL_DSP_SPEED, &speed) < 0 ||
	    speed < NES_AUDIO_RATE * 95 / 100 || speed > NES_AUDIO_RATE * 105 / 100) {
		close(fd);
		return false;
	}
	g_dsp = fd;
	return true;
}

bool audio_open(bool want_dsp, const char *wav_path) {
	if (want_dsp) dsp_open();
	if (wav_path) {
		g_wav = fopen(wav_path, "wb");
		if (g_wav) wav_header(g_wav, 0);
	}
	if (g_dsp >= 0)
		snprintf(g_desc, sizeof(g_desc), "on (/dev/dsp %d Hz%s)", NES_AUDIO_RATE,
		         g_wav ? ", wav" : "");
	else if (g_wav)
		snprintf(g_desc, sizeof(g_desc), "wav only (%d Hz)", NES_AUDIO_RATE);
	else
		snprintf(g_desc, sizeof(g_desc), "off%s", want_dsp ? " (/dev/dsp unavailable)" : "");
	return g_dsp >= 0 || g_wav != NULL;
}

bool audio_live(void) {
	return g_dsp >= 0;
}

void audio_write(const int16_t *samples, int n) {
	if (g_dsp >= 0) {
		const char *p = (const char *)samples;
		size_t left = (size_t)n * 2;
		while (left > 0) {
			ssize_t w = write(g_dsp, p, left);
			if (w < 0) {
				if (errno == EINTR) continue;
				close(g_dsp); /* device went away: quiet downgrade */
				g_dsp = -1;
				break;
			}
			p += w;
			left -= (size_t)w;
		}
	}
	if (g_wav) {
		fwrite(samples, 2, (size_t)n, g_wav);
		g_wav_samples += n;
	}
}

void audio_close(void) {
	if (g_dsp >= 0) {
		close(g_dsp);
		g_dsp = -1;
	}
	if (g_wav) {
		if (fseek(g_wav, 0, SEEK_SET) == 0) wav_header(g_wav, (uint32_t)g_wav_samples);
		fclose(g_wav);
		g_wav = NULL;
	}
}

const char *audio_describe(void) {
	return g_desc;
}
