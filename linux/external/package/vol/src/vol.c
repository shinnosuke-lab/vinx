/* vol -- the machine's volume knob.
 *
 * Why a whole binary for this: ALSA brings the SB16 up with every mixer
 * control at zero. On a desktop, alsactl restores the levels at boot; this
 * image ships no alsa-utils, so without intervention the card stays muted
 * and /dev/dsp plays perfect silence (the DMA runs, the samples die in the
 * mixer). S25vol runs `vol 100` at boot -- the whole "restore".
 *
 * The knob turns through the OSS mixer device (/dev/mixer,
 * CONFIG_SND_MIXER_OSS), i.e. through the driver, so ALSA's control state
 * stays coherent -- unlike poking the SB16 mixer ports directly.
 *
 *   vol        print the current level
 *   vol N      set master and PCM to N percent (0-100)
 */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ioctl.h>
#include <sys/soundcard.h>
#include <unistd.h>

int main(int argc, char **argv) {
	int fd = open("/dev/mixer", O_RDWR);
	if (fd < 0) {
		perror("vol: /dev/mixer");
		return 1;
	}

	if (argc > 1) {
		char *end;
		long n = strtol(argv[1], &end, 10);
		if (*end || n < 0 || n > 100) {
			fprintf(stderr, "usage: vol [0-100]\n");
			return 1;
		}
		int level = (int)n | ((int)n << 8); /* left | right<<8, same both */
		if (ioctl(fd, SOUND_MIXER_WRITE_VOLUME, &level) ||
		    ioctl(fd, SOUND_MIXER_WRITE_PCM, &level)) {
			perror("vol: set");
			return 1;
		}
	}

	int master = 0, pcm = 0;
	ioctl(fd, SOUND_MIXER_READ_VOLUME, &master);
	ioctl(fd, SOUND_MIXER_READ_PCM, &pcm);
	printf("master %d%%  pcm %d%%\n", master & 0xff, pcm & 0xff);
	close(fd);
	return 0;
}
