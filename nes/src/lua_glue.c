/*
 * The scripting layer, and the machine's remote-control socket.
 *
 * Lua 5.4 ships in the vinx image with liblua.so and headers exactly so tcc
 * can do this (`tcc x.c -llua`, says the defconfig). Two ways in:
 *
 *   - init.lua, read once at startup: config (nes.*), keybind-independent
 *     cheats, an emu.on_frame hook.
 *   - /tmp/nes.ctl, a FIFO polled every frame: each line is a Lua chunk.
 *     This is the agent's handle on a running game -- run_shell can
 *     `echo 'joypad.hold({start=true}, 10)' > /tmp/nes.ctl` while the person
 *     plays on the console.
 *
 * The API is FCEUX-shaped: memory.read/write on the CPU bus, joypad.set
 * (this frame) / joypad.hold (N frames), emu.frame/quit/on_frame, and
 * emu.save/load for whole-machine snapshots (agnes state dumps; pair them
 * with /data paths to survive a reload).
 */
#ifdef NES_LUA

#include "nes.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include <lauxlib.h>
#include <lua.h>
#include <lualib.h>

#define CTL_PATH "/tmp/nes.ctl"
#define ON_FRAME_ERROR_LIMIT 8

enum { B_A, B_B, B_SELECT, B_START, B_UP, B_DOWN, B_LEFT, B_RIGHT, B_COUNT };
static const char *const BTN_NAMES[B_COUNT] = {
	"a", "b", "select", "start", "up", "down", "left", "right",
};

static lua_State *L;
static agnes_t *g_agnes;
static int fifo_fd = -1;
static char fifo_acc[4096];
static size_t fifo_len;
static int on_frame_ref = LUA_NOREF;
static int on_frame_errors;
static int lua_hold[B_COUNT]; /* joypad.hold, frames left */
static bool lua_once[B_COUNT]; /* joypad.set, this frame only */
static bool quit_flag;
static unsigned long cur_frame;
static bool g_netplay; /* lockstep active: emu.load would desync, refuse */

/* The terminal may be raw while we print: \r\n or the lines shear. */
static void say(const char *prefix, const char *msg) {
	fprintf(stderr, "\r\n[%s] %s\r\n", prefix, msg);
}

static void buttons_from_table(lua_State *l, int idx, bool out[B_COUNT]) {
	luaL_checktype(l, idx, LUA_TTABLE);
	for (int i = 0; i < B_COUNT; i++) {
		lua_getfield(l, idx, BTN_NAMES[i]);
		out[i] = lua_toboolean(l, -1);
		lua_pop(l, 1);
	}
}

static int l_memory_read(lua_State *l) {
	uint16_t addr = (uint16_t)(luaL_checkinteger(l, 1) & 0xffff);
	lua_pushinteger(l, core_bus_read(g_agnes, addr));
	return 1;
}

static int l_memory_write(lua_State *l) {
	uint16_t addr = (uint16_t)(luaL_checkinteger(l, 1) & 0xffff);
	uint8_t val = (uint8_t)(luaL_checkinteger(l, 2) & 0xff);
	core_bus_write(g_agnes, addr, val);
	return 0;
}

static int l_joypad_set(lua_State *l) {
	bool want[B_COUNT];
	buttons_from_table(l, 1, want);
	for (int i = 0; i < B_COUNT; i++) {
		if (want[i]) lua_once[i] = true;
	}
	return 0;
}

static int l_joypad_hold(lua_State *l) {
	bool want[B_COUNT];
	buttons_from_table(l, 1, want);
	int frames = (int)luaL_optinteger(l, 2, 30);
	if (frames < 1) frames = 1;
	for (int i = 0; i < B_COUNT; i++) {
		if (want[i] && lua_hold[i] < frames) lua_hold[i] = frames;
	}
	return 0;
}

static int l_emu_frame(lua_State *l) {
	lua_pushinteger(l, (lua_Integer)cur_frame);
	return 1;
}

static int l_emu_quit(lua_State *l) {
	(void)l;
	quit_flag = true;
	return 0;
}

static int l_emu_on_frame(lua_State *l) {
	luaL_checktype(l, 1, LUA_TFUNCTION);
	if (on_frame_ref != LUA_NOREF) luaL_unref(l, LUA_REGISTRYINDEX, on_frame_ref);
	lua_pushvalue(l, 1);
	on_frame_ref = luaL_ref(l, LUA_REGISTRYINDEX);
	on_frame_errors = 0;
	return 0;
}

static int l_emu_message(lua_State *l) {
	say("lua", luaL_checkstring(l, 1));
	return 0;
}

static int l_emu_save(lua_State *l) {
	const char *path = luaL_checkstring(l, 1);
	size_t size = agnes_state_size();
	agnes_state_t *state = malloc(size);
	if (!state) return luaL_error(l, "out of memory for a state");
	agnes_dump_state(g_agnes, state);
	FILE *f = fopen(path, "wb");
	bool ok = f && fwrite(state, 1, size, f) == size;
	if (f) fclose(f);
	free(state);
	if (!ok) return luaL_error(l, "could not write %s", path);
	lua_pushboolean(l, 1);
	return 1;
}

static int l_emu_load(lua_State *l) {
	/* One side restoring a state mid-match guarantees a desync (and a
	 * resync would just undo the load) -- refuse instead of pretending. */
	if (g_netplay) return luaL_error(l, "emu.load is disabled during netplay");
	const char *path = luaL_checkstring(l, 1);
	size_t size = agnes_state_size();
	agnes_state_t *state = malloc(size);
	if (!state) return luaL_error(l, "out of memory for a state");
	FILE *f = fopen(path, "rb");
	bool ok = f && fread(state, 1, size, f) == size;
	if (f) fclose(f);
	if (!ok || !agnes_restore_state(g_agnes, state)) {
		free(state);
		return luaL_error(l, "could not restore %s (same ROM as when saved?)", path);
	}
	free(state);
	lua_pushboolean(l, 1);
	return 1;
}

static void register_api(void) {
	static const luaL_Reg memory_fns[] = {
		{"read", l_memory_read}, {"write", l_memory_write}, {NULL, NULL}};
	static const luaL_Reg joypad_fns[] = {
		{"set", l_joypad_set}, {"hold", l_joypad_hold}, {NULL, NULL}};
	static const luaL_Reg emu_fns[] = {
		{"frame", l_emu_frame},     {"quit", l_emu_quit},
		{"on_frame", l_emu_on_frame}, {"message", l_emu_message},
		{"save", l_emu_save},       {"load", l_emu_load},
		{NULL, NULL}};

	luaL_newlib(L, memory_fns);
	lua_setglobal(L, "memory");
	luaL_newlib(L, joypad_fns);
	lua_setglobal(L, "joypad");
	luaL_newlib(L, emu_fns);
	lua_setglobal(L, "emu");
}

static void run_chunk(const char *chunk, size_t len, const char *where) {
	if (luaL_loadbuffer(L, chunk, len, where) != LUA_OK ||
	    lua_pcall(L, 0, 0, 0) != LUA_OK) {
		say("lua error", lua_tostring(L, -1));
		lua_pop(L, 1);
	}
}

bool script_open(agnes_t *agnes, nes_config_t *cfg) {
	g_agnes = agnes;
	g_netplay = cfg->net_mode != NET_OFF;
	L = luaL_newstate();
	if (!L) return false;
	luaL_openlibs(L);
	register_api();

	/* The `nes` config table, preloaded with the current settings. */
	lua_newtable(L);
	lua_pushinteger(L, cfg->frameskip);
	lua_setfield(L, -2, "frameskip");
	lua_pushinteger(L, cfg->hold_frames);
	lua_setfield(L, -2, "hold_frames");
	lua_setglobal(L, "nes");

	const char *path = cfg->lua_path;
	if (path) {
		if (luaL_dofile(L, path) != LUA_OK) {
			fprintf(stderr, "nes: %s\n", lua_tostring(L, -1));
			return false;
		}
	} else if (luaL_dofile(L, "init.lua") == LUA_OK ||
	           luaL_dofile(L, "lua/init.lua") == LUA_OK) {
		lua_settop(L, 0);
	} else {
		lua_settop(L, 0); /* no init script is fine */
	}

	/* Read config back; the command line outranks the script. */
	lua_getglobal(L, "nes");
	if (lua_istable(L, -1)) {
		lua_getfield(L, -1, "frameskip");
		if (!(cfg->cli_set & NES_CLI_FRAMESKIP) && lua_isinteger(L, -1)) {
			cfg->frameskip = (int)lua_tointeger(L, -1);
		}
		lua_getfield(L, -2, "hold_frames");
		if (!(cfg->cli_set & NES_CLI_HOLD) && lua_isinteger(L, -1)) {
			cfg->hold_frames = (int)lua_tointeger(L, -1);
		}
	}
	lua_settop(L, 0);

	/* The control FIFO. EEXIST is a previous run's leftover, reuse it. */
	if (mkfifo(CTL_PATH, 0666) != 0 && errno != EEXIST) {
		fprintf(stderr, "nes: no control fifo (%s)\n", CTL_PATH);
	} else {
		fifo_fd = open(CTL_PATH, O_RDONLY | O_NONBLOCK);
	}
	return true;
}

static void drain_fifo(void) {
	if (fifo_fd < 0) return;
	for (;;) {
		if (fifo_len >= sizeof(fifo_acc) - 1) fifo_len = 0; /* a runaway line */
		ssize_t n = read(fifo_fd, fifo_acc + fifo_len, sizeof(fifo_acc) - 1 - fifo_len);
		if (n <= 0) break; /* 0 = no writer; -1/EAGAIN = no data */
		fifo_len += (size_t)n;
		char *start = fifo_acc;
		char *nl;
		while ((nl = memchr(start, '\n', fifo_len - (size_t)(start - fifo_acc)))) {
			run_chunk(start, (size_t)(nl - start), "=nes.ctl");
			start = nl + 1;
		}
		fifo_len -= (size_t)(start - fifo_acc);
		memmove(fifo_acc, start, fifo_len);
	}
}

void script_frame(agnes_input_t *inout, unsigned long frame, bool *quit) {
	if (!L) return;
	cur_frame = frame;
	drain_fifo();

	if (on_frame_ref != LUA_NOREF) {
		lua_rawgeti(L, LUA_REGISTRYINDEX, on_frame_ref);
		lua_pushinteger(L, (lua_Integer)frame);
		if (lua_pcall(L, 1, 0, 0) != LUA_OK) {
			say("on_frame error", lua_tostring(L, -1));
			lua_pop(L, 1);
			if (++on_frame_errors >= ON_FRAME_ERROR_LIMIT) {
				luaL_unref(L, LUA_REGISTRYINDEX, on_frame_ref);
				on_frame_ref = LUA_NOREF;
				say("lua", "on_frame kept failing and was removed");
			}
		}
	}

	bool pressed[B_COUNT];
	for (int i = 0; i < B_COUNT; i++) {
		pressed[i] = lua_once[i] || lua_hold[i] > 0;
		lua_once[i] = false;
		if (lua_hold[i] > 0) lua_hold[i]--;
	}
	inout->a |= pressed[B_A];
	inout->b |= pressed[B_B];
	inout->select |= pressed[B_SELECT];
	inout->start |= pressed[B_START];
	inout->up |= pressed[B_UP];
	inout->down |= pressed[B_DOWN];
	inout->left |= pressed[B_LEFT];
	inout->right |= pressed[B_RIGHT];

	if (quit_flag) *quit = true;
}

void script_close(void) {
	if (fifo_fd >= 0) close(fifo_fd);
	fifo_fd = -1;
	if (L) lua_close(L);
	L = NULL;
}

#endif /* NES_LUA */
