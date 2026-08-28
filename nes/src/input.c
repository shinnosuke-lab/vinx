/*
 * Two ways buttons reach the machine, both polled every frame and merged:
 *
 *   - evdev, when the kernel has a PS/2 keyboard delivering events (the
 *     page's screen panel injects scancodes when focused). Real press and
 *     release, real holds -- gamepad-grade.
 *   - the controlling tty (ttyS0, the person's console), always. A serial
 *     line carries no key-up, so a keystroke *holds* its button for
 *     `hold_frames` frames and decays. This is the fallback that needs no
 *     page-side support at all.
 *
 * Keys: arrows/WASD move, K or X = A, J or Z = B, Enter = Start,
 * Space = Select, q or Ctrl-C = quit.
 */
#include "nes.h"

#include <stdio.h>

/* Button indices, shared by both backends. */
enum { B_A, B_B, B_SELECT, B_START, B_UP, B_DOWN, B_LEFT, B_RIGHT, B_COUNT };

static int hold[B_COUNT];    /* serial: frames left */
static bool held[B_COUNT];   /* evdev: current state */
static bool tapped[B_COUNT]; /* evdev: went down since the last poll */
static bool want_quit;

#ifdef __linux__

#include <fcntl.h>
#include <linux/input.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static int ev_fd = -1;
static struct termios tty_saved;
static bool tty_is_raw;
static int esc_state;     /* 0 plain, 1 after ESC, 2 after ESC [ */
static int esc_age;       /* polls since the ESC arrived */
static char describe_buf[32];

#define BIT_SET(arr, bit) ((arr)[(bit) / 8] & (1 << ((bit) % 8)))

/* The first event device that looks like a keyboard (has EV_KEY and letters). */
static int evdev_probe(void) {
	for (int i = 0; i < 8; i++) {
		char path[32];
		snprintf(path, sizeof(path), "/dev/input/event%d", i);
		int fd = open(path, O_RDONLY | O_NONBLOCK);
		if (fd < 0) continue;
		unsigned char evbits[(EV_MAX + 7) / 8] = {0};
		unsigned char keybits[(KEY_MAX + 7) / 8] = {0};
		if (ioctl(fd, EVIOCGBIT(0, sizeof(evbits)), evbits) >= 0 &&
		    BIT_SET(evbits, EV_KEY) &&
		    ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keybits)), keybits) >= 0 &&
		    BIT_SET(keybits, KEY_A) && BIT_SET(keybits, KEY_ENTER)) {
			return fd;
		}
		close(fd);
	}
	return -1;
}

static int evdev_button(unsigned code) {
	switch (code) {
		case KEY_UP: case KEY_W: return B_UP;
		case KEY_DOWN: case KEY_S: return B_DOWN;
		case KEY_LEFT: case KEY_A: return B_LEFT;
		case KEY_RIGHT: case KEY_D: return B_RIGHT;
		case KEY_K: case KEY_X: return B_A;
		case KEY_J: case KEY_Z: return B_B;
		case KEY_ENTER: return B_START;
		case KEY_SPACE: return B_SELECT;
		default: return -1;
	}
}

static void evdev_poll(void) {
	if (ev_fd < 0) return;
	struct input_event ev;
	while (read(ev_fd, &ev, sizeof(ev)) == (ssize_t)sizeof(ev)) {
		if (ev.type != EV_KEY) continue;
		if ((ev.code == KEY_Q || ev.code == KEY_ESC) && ev.value == 1) {
			want_quit = true;
			continue;
		}
		int b = evdev_button(ev.code);
		if (b >= 0) {
			held[b] = ev.value != 0; /* 2 = autorepeat = still down */
			/* The whole queue drains in one poll, so a quick tap can go
			 * down AND up between two frames and `held` never shows it.
			 * The latch keeps any press visible for at least one frame. */
			if (ev.value) tapped[b] = true;
		}
	}
}

static int serial_button(unsigned char c) {
	switch (c) {
		case 'w': case 'W': return B_UP;
		case 's': case 'S': return B_DOWN;
		case 'a': case 'A': return B_LEFT;
		case 'd': case 'D': return B_RIGHT;
		case 'k': case 'K': case 'x': case 'X': return B_A;
		case 'j': case 'J': case 'z': case 'Z': return B_B;
		case '\r': case '\n': return B_START;
		case ' ': return B_SELECT;
		default: return -1;
	}
}

static void serial_poll(int hold_frames) {
	if (!tty_is_raw) return;
	if (esc_state && ++esc_age > 3) esc_state = 0; /* a stale, lone ESC */

	unsigned char buf[64];
	ssize_t n;
	while ((n = read(STDIN_FILENO, buf, sizeof(buf))) > 0) {
		for (ssize_t i = 0; i < n; i++) {
			unsigned char c = buf[i];
			if (esc_state == 1) {
				esc_state = c == '[' ? 2 : 0;
				continue;
			}
			if (esc_state == 2) {
				esc_state = 0;
				int b = c == 'A' ? B_UP : c == 'B' ? B_DOWN
				      : c == 'C' ? B_RIGHT : c == 'D' ? B_LEFT : -1;
				if (b >= 0) hold[b] = hold_frames;
				continue;
			}
			if (c == 0x1b) {
				esc_state = 1;
				esc_age = 0;
				continue;
			}
			if (c == 'q' || c == 'Q' || c == 0x03) {
				want_quit = true;
				continue;
			}
			int b = serial_button(c);
			if (b >= 0) hold[b] = hold_frames;
		}
	}
}

bool input_open(void) {
	ev_fd = evdev_probe();

	if (isatty(STDIN_FILENO) && tcgetattr(STDIN_FILENO, &tty_saved) == 0) {
		struct termios raw = tty_saved;
		raw.c_lflag &= ~(tcflag_t)(ICANON | ECHO | ISIG);
		raw.c_iflag &= ~(tcflag_t)(IXON | ICRNL);
		raw.c_cc[VMIN] = 0; /* read() returns immediately, data or not */
		raw.c_cc[VTIME] = 0;
		if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0) tty_is_raw = true;
	}

	snprintf(describe_buf, sizeof(describe_buf), "%s%s",
	         ev_fd >= 0 ? "evdev+" : "", tty_is_raw ? "serial" : "none");
	return true;
}

void input_close(void) {
	if (tty_is_raw) tcsetattr(STDIN_FILENO, TCSANOW, &tty_saved);
	tty_is_raw = false;
	if (ev_fd >= 0) close(ev_fd);
	ev_fd = -1;
}

void input_poll(agnes_input_t *out, bool *quit, int hold_frames) {
	evdev_poll();
	serial_poll(hold_frames);

	out->a = held[B_A] || tapped[B_A] || hold[B_A] > 0;
	out->b = held[B_B] || tapped[B_B] || hold[B_B] > 0;
	out->select = held[B_SELECT] || tapped[B_SELECT] || hold[B_SELECT] > 0;
	out->start = held[B_START] || tapped[B_START] || hold[B_START] > 0;
	out->up = held[B_UP] || tapped[B_UP] || hold[B_UP] > 0;
	out->down = held[B_DOWN] || tapped[B_DOWN] || hold[B_DOWN] > 0;
	out->left = held[B_LEFT] || tapped[B_LEFT] || hold[B_LEFT] > 0;
	out->right = held[B_RIGHT] || tapped[B_RIGHT] || hold[B_RIGHT] > 0;

	for (int i = 0; i < B_COUNT; i++) {
		tapped[i] = false;
		if (hold[i] > 0) hold[i]--;
	}
	if (want_quit) *quit = true;
}

const char *input_describe(void) {
	return describe_buf;
}

#else /* !__linux__: host builds only bench, input is inert */

bool input_open(void) {
	return true;
}
void input_close(void) {}
void input_poll(agnes_input_t *out, bool *quit, int hold_frames) {
	(void)hold_frames;
	static const agnes_input_t none;
	*out = none;
	(void)quit;
}
const char *input_describe(void) {
	return "none";
}

#endif
