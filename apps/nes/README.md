# NES

Vinx 自带的红白机窗口。机器本身是镜像里的 `/usr/bin/nes`（仓库根目录的
`nes/`，由 `linux/external/package/nes` 编进镜像）；这个 app 只补上命令行从来
没有、而卡片上的播放键必须有的一样东西：**选 ROM**。它列出 `/data` 下的
`.nes` 文件（把文件拖到页面上就落在那里），输入编号，游戏在屏幕窗口里画，
游戏自己的输出留在这个终端窗口里，退出后回到列表。

The console's window. The machine is the image's `/usr/bin/nes` (`nes/` at
the repository root, built into the image by `linux/external/package/nes`);
this app adds the one thing a card's play button needs and the command line
never did: picking the ROM. It lists the `.nes` files under `/data` (a file
dropped onto the page lands there), you type a number, the game draws on
the screen window, its own lines stay in this terminal window, and when it
quits the list comes back.

## 按键 / keys

方向键或 WASD 移动，K 或 X = A，J 或 Z = B，Enter = Start，空格 = Select，
q 或 ESC 退出游戏回到列表（`nes/src/input.c`）。在这个窗口里打字，按键经
PTY 到达游戏（终端没有"松开"事件，一次按键按住几帧）；点一下屏幕窗口再
按，就是一块 PS/2 键盘（真实的按下与松开，手感更好）。

Arrows/WASD move, K or X = A, J or Z = B, Enter = Start, Space = Select, q
or ESC quits the game back to the list. Typed in this window, keys reach
the game through the PTY (a terminal carries no key-up, so a keystroke
holds its button a few frames); with the screen window focused they arrive
as a PS/2 keyboard — real press and release, the better pad.

## 里面是什么 / what is in here

- `run` — the picker: a POSIX shell script on the PTY rund opened for the
  window. `find /data -maxdepth 3 -name '*.nes'` (the system's own trees,
  `/data/apps` and `/data/.vinx`, left out), a numbered list, `nes ROM`.
  The exit codes it explains: 75 is fb-run's "the screen is busy" (one
  framebuffer program at a time, §10.5).
- `app.json` — a `kind: window` / `ui.type: tty` manifest (§9): the window
  is an xterm, the program behind it a normal process; the picture is the
  screen window's, opened by the page when the game mode-sets.

The two-player modes (`nes host ROM`, `nes join IP`) stay on the console:
they take arguments this list does not ask for. See `nes/README.md`.

## 改它 / hacking on it

The installed package is the source. Unpack it into the workspace, edit,
and put it back with the same tools the model uses:

    mkdir -p /data/work/nes && tar xzf /data/apps/nes.vapp -C /data/work/nes
    # edit run, then
    app check /data/work/nes && app pack /data/work/nes && app install /data/work/nes.vapp

Uninstalling it (Apps page, or `app remove nes`) is final: a bundled app is
seeded once per machine, it does not come back on the next load. The
console itself stays — `nes ROM.nes` on the command line is the image's.
