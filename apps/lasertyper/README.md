# Laser Typer

Vinx 自带的终端小游戏。字母从屏幕上方落下，按下对应的键，舰炮就朝它发射
激光；连击积攒 X-WAVE，三颗装甲扛失误。ESC 暂停，Q 退出，高分榜存在
`/data/lasertyper.save`。

A typing shooter in a terminal window: letters fall, hit their keys before
they land. Combos charge an X-WAVE; three shields forgive misses. ESC
pauses, Q quits; the high-score table lives in `/data/lasertyper.save`.

## 里面是什么 / what is in here

- `main.c` — the whole game: termbox2 (a single header the machine ships)
  for the drawing, `/dev/dsp` for the sounds, `/data` for the scores.
- `run` — compiles `main.c` with the machine's tcc on the first start after
  a boot, then execs it on the PTY rund opened for the window.
- `app.json` — a `kind: window` / `ui.type: tty` manifest (§9): the window
  is an xterm, the program behind it a normal process.

## 改它 / hacking on it

The installed package is the source. Unpack it into the workspace, edit,
and put it back with the same tools the model uses:

    mkdir -p /data/work/lasertyper && tar xzf /data/apps/lasertyper.vapp -C /data/work/lasertyper
    # edit main.c, then
    app check /data/work/lasertyper && app pack /data/work/lasertyper && app install /data/work/lasertyper.vapp

Uninstalling it (Apps page, or `app remove lasertyper`) is final: a bundled
app is seeded once per machine, it does not come back on the next load.
