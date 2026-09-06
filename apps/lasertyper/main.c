/* LASER TYPER —— 打字射击游戏
 * 字母从天而降,按对应键从舰炮发射激光将其击落。
 * termbox2 渲染 + /dev/dsp 合成音效 + /data 最高分存档。
 * 窗口关闭即退出;游戏内 ESC 暂停,Q 退出。 */
#define TB_IMPL
#include <termbox2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <math.h>
#include <fcntl.h>
#include <unistd.h>

#define MAXE 64            /* 同屏字母上限 */
#define MAXP 360           /* 粒子上限 */
#define MAXL 16            /* 激光束上限 */
#define MAXTXT 8           /* 飘字上限 */
#define MAXR 8             /* 冲击波环上限 */
#define HTS 5              /* 高分榜条数 */
#define NAME_MAX_ 14       /* 玩家名长度 */
#define SAVEF "/data/lasertyper.save"
#define MUSICF "/data/lasertyper.music"

/* ================= 基础工具 ================= */
static double now_s(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec / 1e9;
}
static double clampd(double v, double lo, double hi)
{
	return v < lo ? lo : v > hi ? hi : v;
}
static double rnd(double lo, double hi)
{
	return lo + (hi - lo) * (rand() / (double)RAND_MAX);
}
static uintattr_t dim(uintattr_t a)  { return a | TB_DIM; }
static uintattr_t bold(uintattr_t a) { return a | TB_BOLD; }

/* ================= 音效:/dev/dsp 合成 ================= */
static int dsp = -1;
static short sndbuf[24000];
static int musicOn = 1;

static void snd_open(void)
{
	dsp = open("/dev/dsp", O_WRONLY | O_NONBLOCK);
}
/* type 0 = 激光上滑音,1 = 爆炸噪声 */
static void snd(int type)
{
	int rate = 22050, n = 0, i;
	if (dsp < 0) return;
	if (type == 0) {
		double ph = 0;
		for (i = 0; i < 2200; i++) {
			double f = 850 + 2000 * (i / 2200.0);
			ph += f / rate;
			sndbuf[n++] = (short)(5200 * (1.0 - i / 2200.0) *
			                      (fmod(ph, 1.0) < 0.5 ? 1.0 : -1.0));
		}
	} else {
		unsigned s = (unsigned)rand();
		for (i = 0; i < 8000; i++) {
			double a = pow(1.0 - i / 8000.0, 2.0);
			double nz = ((s >> 16 & 0xffff) / 32768.0 - 1.0) * 0.7;
			double bo = sin(i / (double)rate * 2 * M_PI * 68) * 0.5 * a;
			s = s * 1664525u + 1013904223u;
			sndbuf[n++] = (short)(clampd(8000 * a * (nz + bo), -32000, 32000));
		}
	}
	if (write(dsp, sndbuf, n * sizeof(short)) < 0) { /* 缓冲满则丢弃 */ }
}
static void tone(double freq, double dur_s, double vol)
{
	int total, n = 0, i;
	if (dsp < 0 || !musicOn) return;
	total = (int)(dur_s * 22050);
	if (total < 8) return;
	if (total > 24000) total = 24000;
	for (i = 0; i < total; i++) {
		double a = 1.0 - i / (double)total;
		sndbuf[n++] = (short)(sin(i / 22050.0 * 2 * M_PI * freq) * vol * a * 9000);
	}
	if (write(dsp, sndbuf, n * sizeof(short)) < 0) { /* 丢弃 */ }
}

/* ================= 星空背景 ================= */
static int W, H;
typedef struct { int x, y, fg; float br, ph; } Star;
static Star *stars;
static int nstars;

static void stars_init(void)
{
	int i;
	free(stars);
	nstars = W * H / 26;
	if (nstars < 1) nstars = 1;
	stars = calloc(nstars, sizeof(Star));
	for (i = 0; i < nstars; i++) {
		int m = rand() % 100;
		stars[i].x = rand() % (W ? W : 1);
		stars[i].y = rand() % (H ? H * 2 / 3 : 1);
		stars[i].fg = m < 72 ? TB_WHITE : m < 92 ? TB_CYAN : TB_MAGENTA;
		stars[i].br = (float)rnd(0.4, 1.0);
		stars[i].ph = (float)rnd(0, 6.28);
	}
}
static void stars_draw(double t)
{
	int i;
	for (i = 0; i < nstars; i++) {
		Star *s = &stars[i];
		float tw = 0.55f + 0.45f * (float)sin(t * s->br * 2.5 + s->ph);
		uintattr_t a = s->fg;
		if (tw < 0.45f) a |= TB_DIM;
		else if (tw > 0.85f) a |= TB_BOLD;
		tb_set_cell(s->x, s->y, (i & 1) ? '.' : '*', a, TB_DEFAULT);
	}
}

/* ================= 实体 ================= */
typedef struct {
	int active, letter, tier, frozen;
	double x, y, vx, vy, wob, wobA, born;
} Letter;
typedef struct { int active; double y0, t0; int x; uintattr_t attr; } Laser;
typedef struct { int active; double x, y, vx, vy, life, tot; int ch, fg; } Particle;
typedef struct { int active; double x, y, t0, dur; char txt[14]; uintattr_t attr; } Ftxt;
typedef struct { int active; double x, y, r, vmax; double t0; } Ring;

static Letter ene[MAXE];
static Laser las[MAXL];
static Particle par[MAXP];
static Ftxt ftx[MAXTXT];
static Ring rng[MAXR];
static int nene;

/* ================= 高分榜 ================= */
typedef struct { int score; int wave; char who[NAME_MAX_ + 1]; } HRec;
static HRec hi[HTS];

static void hi_load(void)
{
	FILE *f = fopen(SAVEF, "r");
	int i;
	memset(hi, 0, sizeof(hi));
	if (!f) return;
	for (i = 0; i < HTS; i++) {
		int sc, wv;
		char nm[NAME_MAX_ + 1] = "";
		if (fscanf(f, "%d %d %14[^\n]", &sc, &wv, nm) != 3) break;
		hi[i].score = sc; hi[i].wave = wv;
		snprintf(hi[i].who, sizeof(hi[i].who), "%s", nm[0] ? nm : "???");
		if (!hi[i].score) break;
	}
	fclose(f);
}
static int hi_rank(int score)
{
	int i, r = 1;
	for (i = 0; i < HTS; i++)
		if (hi[i].score >= score) r++;
	return r;
}
static void hi_add(int score, int wave, const char *who)
{
	int i, j;
	hi[HTS - 1].score = score;
	hi[HTS - 1].wave = wave;
	snprintf(hi[HTS - 1].who, sizeof(hi[HTS - 1].who), "%s", who);
	for (i = HTS - 1; i > 0; i--)
		if (hi[i].score > hi[i - 1].score) {
			HRec tmp = hi[i]; hi[i] = hi[i - 1]; hi[i - 1] = tmp;
		}
	for (j = HTS - 1; j >= 0; j--)
		if (!hi[j].score) { memset(&hi[j], 0, sizeof(HRec)); }
	FILE *f = fopen(SAVEF, "w");
	if (f) {
		for (i = 0; i < HTS; i++)
			if (hi[i].score)
				fprintf(f, "%d %d %s\n", hi[i].score, hi[i].wave, hi[i].who);
		fclose(f);
	}
}

/* 自定义按键音:/data/lasertyper.music 每行 "字母 频率" */
static double keyfreq[26];
static void music_load(void)
{
	FILE *f = fopen(MUSICF, "r");
	int i;
	for (i = 0; i < 26; i++) keyfreq[i] = 0;
	if (!f) return;
	while (1) {
		char L[8]; double fr;
		if (fscanf(f, "%7s %lf", L, &fr) != 2) break;
		if (L[0] >= 'A' && L[0] <= 'Z' && fr >= 40 && fr <= 20000)
			keyfreq[L[0] - 'A'] = fr;
	}
	fclose(f);
}

/* ================= 生成器 ================= */
static void fspawn(double x, double y, const char *s, uintattr_t a, double dur)
{
	int i;
	for (i = 0; i < MAXTXT; i++) {
		Ftxt *p = &ftx[i];
		if (p->active) continue;
		p->active = 1; p->x = x; p->y = y; p->t0 = now_s(); p->dur = dur;
		p->attr = a;
		snprintf(p->txt, sizeof(p->txt), "%s", s);
		return;
	}
}
static void pspawn(double x, double y, int cnt, int fg, double spread, double up)
{
	int i, c = 0;
	for (i = 0; i < MAXP && c < cnt; i++) {
		Particle *p = &par[i];
		double a, sp;
		if (p->active) continue;
		a = rnd(0, 2 * M_PI); sp = rnd(4, spread);
		p->active = 1; p->x = x; p->y = y;
		p->vx = cos(a) * sp * 0.8;
		p->vy = sin(a) * sp * 0.6 - up;
		p->tot = p->life = rnd(0.35, 0.9);
		p->ch = (rand() % 3 == 0) ? '+' : (rand() % 4 ? '*' : 'x');
		p->fg = fg;
		c++;
	}
}
static void ring_spawn(double x, double y, double vmax)
{
	int i;
	for (i = 0; i < MAXR; i++) {
		Ring *r = &rng[i];
		if (r->active) continue;
		r->active = 1; r->x = x; r->y = y; r->r = 0;
		r->vmax = vmax; r->t0 = now_s();
		return;
	}
}

/* ================= 游戏状态 ================= */
static int score, combo, bestCombo, kills, wave, toKill, armor, blastReady;
static int gunXof(void) { return W / 2; }
static int groundY(void) { return H - 5; }

static uintattr_t tier_fg(int tier)
{
	switch (tier) {
	case 0: return TB_GREEN;
	case 1: return TB_CYAN | TB_BOLD;
	case 2: return TB_MAGENTA | TB_BOLD;
	default: return TB_YELLOW | TB_BOLD;
	}
}
static const char *tier_glyph(int tier)
{
	switch (tier) {
	case 0: return "·";
	case 1: return "+";
	case 2: return "✦";
	default: return "★";
	}
}

static void spawn_letter(double t)
{
	int i, used[26] = {0}, pool[26], np = 0, tries;
	Letter *e = NULL;
	for (i = 0; i < MAXE; i++)
		if (ene[i].active) used[ene[i].letter] = 1;
		else if (!e) e = &ene[i];
	if (!e) return;
	for (i = 0; i < 26; i++) if (!used[i]) pool[np++] = i;
	if (!np) return;
	for (tries = 0; tries < 8; tries++) {
		e->letter = pool[rand() % np];
		if (abs(e->letter + 'A' - gunXof()) > 6) break;  /* 别正好压在炮口上 */
	}
	/* 关卡越深,高级字母越多 */
	int roll = rand() % 100;
	int t2 = wave >= 3, t3 = wave >= 5;
	if (t3 && roll < 4 + wave) e->tier = 3;
	else if (t2 && roll < 12 + wave * 2) e->tier = 2;
	else if (roll < 28 + wave * 3) e->tier = 1;
	else e->tier = 0;
	e->frozen = 0;
	e->x = clampd(rnd(2 + e->letter * 0.9, W - 3 - (25 - e->letter) * 0.9), 2, W - 3);
	e->y = -rnd(0.5, 3);
	e->vy = rnd(1.5, 2.4) * (1.0 + wave * 0.08 + e->tier * 0.22);
	e->vx = rnd(-0.5, 0.5);
	e->wob = rnd(0, 6.28); e->wobA = rnd(0.3, 1.4);
	e->born = t;
	e->active = 1;
}

/* 击杀:粒子 + 飘字 + 得分 + 连击 */
static void kill_letter(Letter *e, double t, int fromBlast)
{
	char buf[14];
	int base = 10 + e->tier * 10;
	int pts = base * (1 + combo / 8) + (fromBlast ? 5 : 0);
	e->active = 0;
	score += pts; kills++; combo++;
	if (combo > bestCombo) bestCombo = combo;
	if (combo > 0 && combo % 12 == 0) blastReady = 1;
	pspawn(e->x, e->y, 14 + e->tier * 6, tier_fg(e->tier), 14 + e->tier * 5, 2.5);
	pspawn(e->x, e->y, 6, TB_YELLOW | TB_BOLD, 20, 3);
	if (e->tier >= 2) ring_spawn(e->x, e->y, 4 + e->tier * 2);
	snprintf(buf, sizeof(buf), "+%d", pts);
	fspawn(e->x, e->y, buf, e->tier ? TB_YELLOW | TB_BOLD : TB_WHITE, 0.7);
	if (!fromBlast) snd(1);
	if (e->tier == 3) tone(1568, 0.12, 0.9);
}

/* ================= 渲染 ================= */
static void put(int x, int y, const char *s, uintattr_t fg)
{
	if (x >= 0 && x < W && y >= 0 && y < H) tb_printf(x, y, fg, TB_DEFAULT, "%s", s);
}

/* 双行方块大字:5x5 点阵,scale=1 */
static const int *glyph(int c)
{
	static const int L[] = {16,16,16,16,31}, A[] = {14,17,31,17,17},
		S[] = {15,16,14,1,30}, E[] = {31,16,30,16,31}, R[] = {30,17,30,18,17},
		T[] = {31,4,4,4,4}, Y[] = {17,17,14,4,4}, P[] = {30,17,30,16,16},
		SP[] = {0,0,0,0,0};
	switch (c) {
	case 'L': return L; case 'A': return A; case 'S': return S; case 'E': return E;
	case 'R': return R; case 'T': return T; case 'Y': return Y; case 'P': return P;
	default: return SP;
	}
}
static void logo(int x0, int y0, const char *word, uintattr_t fg)
{
	int i, r, b;
	for (i = 0; word[i]; i++) {
		const int *g = glyph(word[i]);
		for (r = 0; r < 5; r++)
			for (b = 4; b >= 0; b--)
				if (g[r] & (1 << b))
					tb_set_cell(x0 + i * 6 + (4 - b), y0 + r, 0x2588, fg, TB_DEFAULT);
	}
}

static void draw_frame(double t)
{
	int i, x, y;
	tb_clear();
	stars_draw(t);
	/* 城市剪影 */
	for (x = 0; x < W; x++) {
		unsigned hsh = (unsigned)x * 2654435761u;
		int bh = 1 + hsh % 3;
		uintattr_t c = (hsh >> 8 & 1) ? dim(TB_BLUE) : dim(TB_CYAN);
		for (y = 0; y < bh; y++)
			tb_set_cell(x, H - 1 - y, 0x2593, c, TB_DEFAULT);
	}
	/* 地平线 */
	for (x = 0; x < W; x++)
		tb_set_cell(x, H - 1, 0x2580, dim(TB_MAGENTA), TB_DEFAULT);
}

static void draw_entity_layer(double t)
{
	int i, j;
	/* 冲击波环 */
	for (i = 0; i < MAXR; i++) {
		Ring *r = &rng[i];
		double age, k;
		int a;
		if (!r->active) continue;
		age = t - r->t0; k = age / 0.45;
		if (k >= 1) { r->active = 0; continue; }
		for (a = 0; a < 12; a++) {
			double ang = a / 12.0 * 2 * M_PI;
			int px = (int)(r->x + cos(ang) * r->r);
			int py = (int)(r->y + sin(ang) * r->r * 0.55);
			uintattr_t col = k < 0.5 ? bold(TB_YELLOW) : dim(TB_CYAN);
			tb_set_cell(px, py, '+', col, TB_DEFAULT);
		}
	}
	/* 字母 */
	for (i = 0; i < MAXE; i++) {
		Letter *e = &ene[i];
		uintattr_t fg;
		if (!e->active) continue;
		fg = tier_fg(e->tier);
		if (t - e->born < 0.5) fg = dim(fg);
		/* 拖尾 */
		for (j = 1; j <= 3; j++) {
			int ty = (int)(e->y - j * 0.7);
			if (ty >= 0 && ty < H)
				tb_set_cell((int)(e->x + 0.5), ty, '|',
				            j == 1 ? dim(fg) : (j == 2 ? dim(TB_BLUE) : TB_HI_BLACK),
				            TB_DEFAULT);
		}
		tb_set_cell((int)(e->x + 0.5), (int)(e->y + 0.5), 'A' + e->letter,
		            e->frozen ? bold(TB_WHITE) : fg, TB_DEFAULT);
		/* 护盾/等级标记 */
		if (e->tier >= 2) {
			tb_set_cell((int)(e->x + 0.5) - 1, (int)(e->y + 0.5), '<', dim(fg), TB_DEFAULT);
			tb_set_cell((int)(e->x + 0.5) + 1, (int)(e->y + 0.5), '>', dim(fg), TB_DEFAULT);
		}
	}
	/* 激光 */
	for (i = 0; i < MAXL; i++) {
		Laser *l = &las[i];
		double prog, headY;
		int y2;
		if (!l->active) continue;
		prog = (t - l->t0) / 0.07;
		if (prog >= 1) { l->active = 0; continue; }
		headY = l->y0 - prog * (l->y0 - 0.5);
		for (y2 = (int)headY; y2 <= (int)l->y0; y2++) {
			uintattr_t c = ((y2 - l->x) & 3) == 0 ? bold(TB_WHITE)
			               : ((y2 & 1) ? bold(TB_CYAN) : TB_CYAN);
			tb_set_cell(l->x, y2, (y2 & 1) ? 0x2588 : 0x2593, c, TB_DEFAULT);
		}
		tb_set_cell(l->x, (int)headY - 1, '^', bold(TB_WHITE), TB_DEFAULT);
	}
	/* 粒子 */
	for (i = 0; i < MAXP; i++) {
		Particle *p = &par[i];
		uintattr_t c;
		if (!p->active) continue;
		c = p->life / p->tot > 0.45 ? p->fg : dim(p->fg & ~TB_BOLD);
		tb_set_cell((int)(p->x + 0.5), (int)(p->y + 0.5), p->ch, c, TB_DEFAULT);
	}
	/* 飘字 */
	for (i = 0; i < MAXTXT; i++) {
		Ftxt *p = &ftx[i];
		double k;
		int len, sx;
		if (!p->active) continue;
		k = (t - p->t0) / p->dur;
		if (k >= 1) { p->active = 0; continue; }
		len = (int)strlen(p->txt);
		sx = (int)(p->x + 0.5) - len / 2;
		put(sx, (int)(p->y - k * 2 + 0.5), p->txt, k < 0.6 ? p->attr : dim(p->attr));
	}
}

static void draw_ship(double t, double lastShot)
{
	int gx = gunXof(), y;
	uintattr_t hot = blastReady ? bold(TB_YELLOW) : bold(TB_CYAN);
	if (t - lastShot < 0.08)
		tb_set_cell(gx, H - 6, 0x2726 /* ✦ */, bold(TB_WHITE), TB_DEFAULT);
	tb_set_cell(gx, H - 5, '|', hot, TB_DEFAULT);
	tb_set_cell(gx - 1, H - 4, 0x259F /*▟*/, TB_MAGENTA, TB_DEFAULT);
	tb_set_cell(gx, H - 4, 0x2588 /*█*/, hot, TB_DEFAULT);
	tb_set_cell(gx + 1, H - 4, 0x2599 /*▙*/, TB_MAGENTA, TB_DEFAULT);
	tb_set_cell(gx - 2, H - 3, 0x259B /*▛*/, dim(TB_MAGENTA), TB_DEFAULT);
	tb_set_cell(gx - 1, H - 3, 0x2588, bold(TB_MAGENTA), TB_DEFAULT);
	tb_set_cell(gx, H - 3, 0x2588, bold(TB_WHITE), TB_DEFAULT);
	tb_set_cell(gx + 1, H - 3, 0x2588, bold(TB_MAGENTA), TB_DEFAULT);
	tb_set_cell(gx + 2, H - 3, 0x259C /*▜*/, dim(TB_MAGENTA), TB_DEFAULT);
	for (y = H - 2; y < H; y++) { /* 舰体落进城市层,别留空洞 */
		if (y == H - 2) {
			tb_set_cell(gx - 1, y, 0x2584 /*▄*/, dim(TB_MAGENTA), TB_DEFAULT);
			tb_set_cell(gx, y, 0x2584, TB_MAGENTA, TB_DEFAULT);
			tb_set_cell(gx + 1, y, 0x2584, dim(TB_MAGENTA), TB_DEFAULT);
		}
	}
}

static void draw_hud(double t)
{
	char buf[64];
	int x, i;
	/* 第一行:标题 + 装甲 + 分数 */
	tb_printf(1, 0, bold(TB_CYAN), TB_DEFAULT, " LASER TYPER ");
	for (i = 0; i < 3; i++)
		tb_printf(14 + i * 2, 0, i < armor ? bold(TB_RED) : TB_HI_BLACK,
		          TB_DEFAULT, "%s", "❤");
	snprintf(buf, sizeof(buf), "%06d", score);
	tb_printf(W - 11, 0, bold(TB_YELLOW), TB_DEFAULT, "分数 %s", buf);
	/* 第二行:关卡进度 + 连击 */
	snprintf(buf, sizeof(buf), "LV%d [", wave);
	tb_printf(1, 1, TB_WHITE, TB_DEFAULT, "%s", buf);
	x = 1 + (int)strlen(buf);
	for (i = 0; i < 10; i++)
		tb_printf(x + i, 1, i < 10 - toKill ? TB_GREEN : dim(TB_WHITE),
		          TB_DEFAULT, "%s", "▪");
	tb_printf(x + 10, 1, TB_WHITE, TB_DEFAULT, "]");
	if (combo >= 2)
		tb_printf(W - 26, 1, combo >= 8 ? bold(TB_YELLOW) : TB_WHITE,
		          TB_DEFAULT, "COMBO x%d", combo);
	if (blastReady && ((int)(t * 4) & 1))
		tb_printf(W / 2 - 8, 1, bold(TB_YELLOW), TB_DEFAULT, "✦ X-WAVE ✦");
	/* 提示行 */
	put(1, H - 7, "击键=发射对应字母  ESC 暂停", dim(TB_WHITE));
}

/* ================= 屏幕切换 ================= */
enum { ST_TITLE, ST_PLAY, ST_PAUSE, ST_OVER, ST_ENTRY, ST_SCORES };

static void center_str(int y, const char *s, uintattr_t fg)
{
	put(W / 2 - (int)strlen(s) / 2, y, s, fg);
}

static void draw_title(double t)
{
	int i;
	/* 背景飘落的装饰字母 */
	for (i = 0; i < 12; i++) {
		double sp = 3 + (i % 5);
		int x = (int)((i * 7919L) % (W - 4)) + 2;
		int y = (int)(fmod(t * sp + i * 7, H + 4)) - 2;
		tb_set_cell(x, y, 'A' + (i * 7 + 3) % 26, dim(TB_CYAN), TB_DEFAULT);
	}
	logo(W / 2 - 33, 3, "LASER", bold(TB_CYAN));
	logo(W / 2 + 3, 3, "TYPER", bold(TB_MAGENTA));
	center_str(9, "—— 每一个按键,都是一门炮 ——", dim(TB_WHITE));
	center_str(12, "[ENTER] 开始游戏   [H] 高分榜", TB_WHITE);
	center_str(13, musicOn ? "[M] 按键音效:开" : "[M] 按键音效:关", dim(TB_WHITE));
	{
		char b[48];
		snprintf(b, sizeof(b), "最高纪录 %d 分 · 第 %d 波", hi[0].score, hi[0].wave);
		if (hi[0].score) center_str(16, b, TB_YELLOW);
	}
	center_str(H - 2, "A-Z 发射 · 连击积攒 X-WAVE · 三颗装甲", dim(TB_WHITE));
}

static void draw_pause(void)
{
	int bx = W / 2 - 14, by = H / 2 - 3, i;
	for (i = 0; i < 28; i++) {
		tb_set_cell(bx + i, by, 0x2500, TB_CYAN, TB_DEFAULT);
		tb_set_cell(bx + i, by + 6, 0x2500, TB_CYAN, TB_DEFAULT);
	}
	for (i = 1; i < 6; i++) {
		tb_set_cell(bx, by + i, 0x2502, TB_CYAN, TB_DEFAULT);
		tb_set_cell(bx + 27, by + i, 0x2502, TB_CYAN, TB_DEFAULT);
	}
	put(bx + 10, by + 1, "已 暂 停", bold(TB_CYAN));
	put(bx + 4, by + 3, "ESC 继续 · ENTER 回主菜单", TB_WHITE);
}

static void draw_scores(void)
{
	char b[64];
	int i;
	center_str(2, "◆ 高分榜 ◆", bold(TB_YELLOW));
	for (i = 0; i < HTS; i++) {
		if (!hi[i].score) break;
		snprintf(b, sizeof(b), "%2d. %-14s %6d 分  第%2d波",
		         i + 1, hi[i].who, hi[i].score, hi[i].wave);
		center_str(4 + i * 2, b, i == 0 ? bold(TB_YELLOW) : TB_WHITE);
	}
	if (!hi[0].score) center_str(4, "虚位以待", dim(TB_WHITE));
	center_str(H - 2, "按任意键返回", dim(TB_WHITE));
}

static void draw_over(int newHi, double t)
{
	char b[64];
	int i;
	center_str(H / 2 - 6, "═╣ 阵 亡 ╠═", bold(TB_RED));
	snprintf(b, sizeof(b), "本局得分  %d", score);
	center_str(H / 2 - 3, b, bold(TB_YELLOW));
	snprintf(b, sizeof(b), "抵达第 %d 波 · 击落 %d 个 · 最高连击 x%d",
	         wave, kills, bestCombo);
	center_str(H / 2 - 1, b, TB_WHITE);
	if (newHi)
		center_str(H / 2 + 1, "★ 新纪录!输入你的大名 ★",
		           ((int)(t * 3) & 1) ? bold(TB_YELLOW) : TB_WHITE);
	center_str(H / 2 + 4, "ENTER 继续", dim(TB_WHITE));
}

static void draw_entry(const char *name, int nlen)
{
	char b[NAME_MAX_ + 4];
	int i;
	center_str(H / 2 + 1, "名字:", TB_WHITE);
	snprintf(b, sizeof(b), "%s", name);
	for (i = 0; i < NAME_MAX_; i++)
		put(W / 2 + 2 + i * 2, H / 2 + 1, i < nlen ? (char[]){name[i], 0} : "_",
		    i == nlen ? bold(TB_YELLOW) : dim(TB_WHITE));
	center_str(H / 2 + 3, "输入字母 · ENTER 确认", dim(TB_WHITE));
}

/* ================= 主循环 ================= */
int main(void)
{
	int state = ST_TITLE, i, running = 1;
	double t, last = 0, acc = 0, lastShot = -9, spawnAt = 0, shake = 0;
	double stT = 0, overAt = 0;
	int newHi = 0, nlen = 0, blinkGear = 0;
	char name[NAME_MAX_ + 1];
	struct tb_event ev;

	srand((unsigned)time(NULL) ^ 0x5eed);
	snd_open();
	hi_load();
	music_load();
	snprintf(name, sizeof(name), "%s", "PILOT");

	if (tb_init() != 0) return 1;
	tb_set_input_mode(TB_INPUT_ESC);   /* 纯 ESC 模式:独立 ESC 键立即上报 */
	W = tb_width(); H = tb_height();
	stars_init();

	while (running) {
		double dt;
		int r = tb_peek_event(&ev, 20);
		t = now_s();
		dt = t - last; last = t;
		if (dt > 0.1) dt = 0.1;

		/* ---- 输入 ---- */
		if (r == TB_OK && ev.type == TB_EVENT_KEY) {
			if (ev.key == TB_KEY_CTRL_C) { running = 0; goto draw; }
			switch (state) {
			case ST_TITLE:
				if (ev.key == TB_KEY_ENTER) {
					score = combo = bestCombo = kills = 0;
					wave = 1; toKill = 10 + wave; armor = 3; blastReady = 0;
					memset(ene, 0, sizeof(ene));
					memset(par, 0, sizeof(par));
					memset(ftx, 0, sizeof(ftx));
					memset(rng, 0, sizeof(rng));
					memset(las, 0, sizeof(las));
					nene = 0; spawnAt = t + 0.8;
					state = ST_PLAY; stT = t;
					tone(660, 0.08, 0.7); tone(990, 0.1, 0.7);
				}
				else if (ev.ch == 'h' || ev.ch == 'H') state = ST_SCORES;
				else if (ev.ch == 'm' || ev.ch == 'M') musicOn = !musicOn;
				else if (ev.ch == 'q' || ev.ch == 'Q') running = 0;
				break;
			case ST_SCORES:
				state = ST_TITLE;
				break;
			case ST_PLAY:
				if (ev.key == TB_KEY_ESC) { state = ST_PAUSE; break; }
				/* 注意:Q 在游戏里是打字母 Q 的炮键,退出只走暂停菜单 */
				if (ev.ch >= 'a' && ev.ch <= 'z') ev.ch -= 32;
				if (ev.ch >= 'A' && ev.ch <= 'Z') {
					int li = ev.ch - 'A';
					Letter *best = NULL; double bestY = -9;
					for (i = 0; i < MAXE; i++) {
						Letter *e = &ene[i];
						if (!e->active || e->letter != li) continue;
						if (e->y > bestY) { bestY = e->y; best = e; }
					}
					for (i = 0; i < MAXL; i++)
						if (!las[i].active) {
							las[i].active = 1; las[i].t0 = t;
							las[i].x = gunXof(); las[i].y0 = H - 5;
							las[i].attr = bold(TB_CYAN);
							break;
						}
					lastShot = t;
					if (keyfreq[li]) tone(keyfreq[li], 0.14, 0.8);
					snd(0);
					if (best) {
						int blast = blastReady;
						if (blast) {
							blastReady = 0;
							ring_spawn(best->x, best->y, 16);
							pspawn(best->x, best->y, 40, bold(TB_YELLOW), 26, 4);
							fspawn(best->x, best->y - 1, "X-WAVE!", bold(TB_YELLOW), 0.9);
							tone(2093, 0.18, 0.9);
						}
						kill_letter(best, t, blast);
						if (blast) {
							/* 冲击波顺带杀伤 */
							for (i = 0; i < MAXE; i++) {
								Letter *e = &ene[i];
								double dx, dy;
								if (!e->active || e == best) continue;
								dx = e->x - best->x; dy = e->y - best->y;
								if (dx * dx + dy * dy * 3 < 60)
									kill_letter(e, t, 1);
							}
							shake = 0.2;
						}
						if (best->tier >= 2) shake = 0.12;
					} else {
						/* 打空:断连击,不扣装甲(落地才扣) */
						combo = 0;
						pspawn(gunXof(), H - 5, 8, TB_RED, 10, 1);
						fspawn(gunXof() + 1, H - 6, "MISS", bold(TB_RED), 0.8);
						tone(150, 0.22, 0.9);
					}
				}
				break;
			case ST_PAUSE:
				if (ev.key == TB_KEY_ESC) state = ST_PLAY;
				else if (ev.key == TB_KEY_ENTER) state = ST_TITLE;
				break;
			case ST_OVER:
				if (ev.key == TB_KEY_ENTER && t - overAt > 0.8) {
					if (newHi) { state = ST_ENTRY; nlen = 0; name[0] = 0; }
					else state = ST_TITLE;
				}
				break;
			case ST_ENTRY:
				if (ev.key == TB_KEY_ENTER) {
					hi_add(score, wave, nlen ? name : "无名氏");
					state = ST_TITLE;
					tone(880, 0.1, 0.8);
				} else if (ev.key == TB_KEY_BACKSPACE && nlen > 0) {
					name[--nlen] = 0;
				} else if (ev.key == TB_KEY_ESC) {
					hi_add(score, wave, "无名氏");
					state = ST_TITLE;
				} else if (ev.ch >= 'a' && ev.ch <= 'z') {
					if (nlen < NAME_MAX_) { name[nlen++] = (char)(ev.ch - 32); name[nlen] = 0; }
				} else if (ev.ch >= 'A' && ev.ch <= 'Z') {
					if (nlen < NAME_MAX_) { name[nlen++] = (char)ev.ch; name[nlen] = 0; }
				}
				break;
			}
		}
		if (r == TB_OK && ev.type == TB_EVENT_RESIZE) {
			W = tb_width(); H = tb_height();
			stars_init();
		}

		/* ---- 逻辑更新 ---- */
		if (state == ST_PLAY) {
			nene = 0;
			for (i = 0; i < MAXE; i++) if (ene[i].active) nene++;
			if (t >= spawnAt && nene < 4 + wave && nene < MAXE) {
				spawn_letter(t);
				spawnAt = t + clampd(1.30 - wave * 0.035 - combo * 0.004, 0.40, 1.30);
			}
			for (i = 0; i < MAXE; i++) {
				Letter *e = &ene[i];
				if (!e->active) continue;
				nene++;
				e->y += e->vy * dt;
				e->x += e->vx * dt + sin(t * 2 + e->wob) * e->wobA * dt;
				if (e->x < 1) { e->x = 1; e->vx = fabs(e->vx); }
				if (e->x > W - 2) { e->x = W - 2; e->vx = -fabs(e->vx); }
				if (e->y >= groundY()) {
					/* 触地:爆炸并扣装甲 */
					e->active = 0;
					armor--;
					combo = 0;
					pspawn(e->x, groundY(), 26, TB_RED | TB_BOLD, 18, 6);
					ring_spawn(e->x, groundY(), 8);
					fspawn(e->x, groundY() - 1, "-1 装甲", bold(TB_RED), 0.9);
					snd(1); shake = 0.25;
					if (armor <= 0) {
						state = ST_OVER; overAt = t;
						newHi = hi_rank(score) <= HTS;
						nlen = 0; name[0] = 0;
						pspawn(gunXof(), H - 4, 80, TB_RED | TB_BOLD, 24, 5);
						shake = 0.5;
					}
				}
			}
			/* 激光推进时也结算命中(视觉上先掠过再爆) */
			for (i = 0; i < MAXL; i++) {
				Laser *l = &las[i];
				double prog, headY;
				int j;
				if (!l->active) continue;
				prog = (t - l->t0) / 0.07;
				headY = l->y0 - clampd(prog, 0, 1) * (l->y0 - 0.5);
				for (j = 0; j < MAXE; j++) {
					Letter *e = &ene[j];
					if (!e->active) continue;
					if (e->y >= headY - 1 && abs((int)(e->x + 0.5) - l->x) <= 1) {
						char k = 0;
						/* 激光只在推进中杀死其头部以下扫过的字母 */
						if (t - l->t0 < 0.07) k = 1;
						if (k) kill_letter(e, t, 0);
					}
				}
			}
			/* 波次结算 */
			if (toKill <= 0 && state == ST_PLAY) {
				wave++;
				toKill = 10 + wave;
				fspawn(W / 2 - 4, H / 2, "WAVE UP!", bold(TB_CYAN), 1.2);
				tone(523, 0.09, 0.7); tone(659, 0.09, 0.7); tone(784, 0.14, 0.7);
				armor = 3; /* 波间修满装甲 */
				stT = t;
			}
		}
		/* 粒子/飘字/环在所有状态下都衰减(死亡爆炸要继续放) */
		{
			int anyPar = 0;
			for (i = 0; i < MAXP; i++) {
				Particle *p = &par[i];
				if (!p->active) continue;
				anyPar = 1;
				p->life -= dt;
				if (p->life <= 0) { p->active = 0; continue; }
				p->x += p->vx * dt;
				p->y += p->vy * dt;
				p->vy += 14 * dt;   /* 重力 */
			}
			(void)anyPar;
			for (i = 0; i < MAXR; i++)
				if (rng[i].active) rng[i].r += rng[i].vmax * dt * 3;
		}
		if (shake > 0) shake -= dt;

draw:
		/* ---- 绘制 ---- */
		acc += dt;
		if (acc < 0.033) continue;   /* ~30fps */
		acc = 0;
		blinkGear = !blinkGear;
		tb_clear();
		if (shake > 0) {
			/* 屏幕抖动:整体随机偏移一格 */
			int ox = rand() % 3 - 1, oy = rand() % 2;
			(void)ox; (void)oy;  /* termbox 无全局原点,抖动用粒子表现 */
		}
		if (state == ST_TITLE) {
			draw_frame(t);
			draw_title(t);
		} else if (state == ST_SCORES) {
			draw_frame(t);
			draw_scores();
		} else {
			draw_frame(t);
			draw_entity_layer(t);
			draw_ship(t, lastShot);
			draw_hud(t);
			if (state == ST_PAUSE) draw_pause();
			else if (state == ST_OVER) draw_over(newHi, t);
			else if (state == ST_ENTRY) draw_entry(name, nlen);
			else if (t - stT < 1.0) {
				char b[32];
				snprintf(b, sizeof(b), "第 %d 波 · 准备!", wave);
				center_str(H / 2, b, bold(TB_CYAN));
			}
		}
		(void)blinkGear;
		tb_present();
	}
	tb_shutdown();
	return 0;
}
