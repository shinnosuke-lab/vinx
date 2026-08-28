# The console's opening screen: the mascot beside the name in big type, then
# what this machine can do that a stock busybox cannot. Named 00- so it sorts
# (and prints) ahead of the other profile.d snippets. Interactive shells only
# -- run_shell (agentd) runs plain `sh` and never sources this.
#
# The lynx is the page logo itself (/usr/share/vinx/logo.png, 384px), sent as
# a real PNG over iTerm2's inline-image protocol (OSC 1337) -- the page's
# @xterm/addon-image draws actual pixels, sharp on Retina where the old
# half-block character art could not be. height=10 (cells; width follows the
# square's aspect, ~18 cells -- inside the art's old 20-cell footprint) is
# the one sizing the addon honours exactly, so the row count is fixed and the
# cursor arithmetic below cannot drift with font metrics. The addon parks the
# cursor on the image's last row at its left edge; from there the figlet
# "slant" name -- one 24-bit colour per row, the brand's copper fading up
# into cream -- is walked back up with cursor moves into its old place
# beside the image.
case "$-" in
	*i*)
		# The first login after boot wipes the screen -- and the scrollback
		# (3J) -- so the kernel's boot chatter (harmless v86 quirks: no ACPI
		# tables, a bare MP table, no OPL chip...) doesn't sit above the
		# banner. dmesg still has all of it. The /run flag (tmpfs, empty
		# each boot) keeps later logins -- exit, exec sh -l -- from
		# flashing the screen clear again.
		[ -e /run/.banner-shown ] || {
			: > /run/.banner-shown
			printf '\033[H\033[2J\033[3J'
		}
		printf '  \033]1337;File=size=%s;inline=1;height=10:%s\a' \
			"$(wc -c < /usr/share/vinx/logo.png)" \
			"$(base64 /usr/share/vinx/logo.png | tr -d '\n')"
		# Cursor is now on the image's last row (10 of 10). Up 7 puts the
		# name on image rows 3-7; column 26 clears the 20-cell image box
		# plus the same 3-space gutter the character art kept.
		printf '\033[7A'
		_f() { printf '\033[26G%b\033[B' "$1"; }
		_f '\033[38;2;178;94;26m _    _______   ___  __\033[0m'
		_f '\033[38;2;205;117;29m| |  / /  _/ | / / |/ /\033[0m'
		_f '\033[38;2;219;135;41m| | / // //  |/ /|   /\033[0m'
		_f '\033[38;2;233;152;53m| |/ // // /|  //   |\033[0m'
		_f '\033[38;2;240;180;110m|___/___/_/ |_//_/|_|\033[0m'
		# Back below the image (rows 8-10), one blank line, banner text.
		printf '\n\n\n\n'
		printf '  \033[1;38;2;245;236;220mvinx linux\033[0;38;2;170;158;145m -- a real i686 machine, entirely in your browser tab\033[0m\n'
		printf '  \033[38;2;92;80;70m─────────────────────────────────────────────────────────────────\033[0m\n'
		# A command line: cyan for what you type, soft white for what it does.
		_k() { printf '  \033[1;38;2;125;207;255m%-20s\033[0;38;2;169;177;214m%s\033[0m\n' "$1" "$2"; }
		_k 'open FILE|URL' 'the browser renders it, or saves it under its own name'
		_k 'imgcat FILE' 'the image, inline (-w 50%|800px sizes it)'
		_k 'download FILE' 'straight to your machine'
		_k 'share local FILE' 'into /data/share/local -- every tab and pane sees it'
		_k 'microcom /dev/ttyS2' 'a real serial device, wired in from the footer'
		_k 'ble connect' 'a Bluetooth device: GATT read/write/notify from here'
		_k 'notify, say, camera' 'the browser: a notification, a voice, a webcam frame'
		_k 'js -e CODE' "JavaScript on the page itself -- DOM, browser fetch"
		_k 'fetch URL' 'HTTP via the browser, zero setup (CORS applies)'
		_k 'fbdemo' 'paints /dev/fb0 -- the footer screen chip shows it'
		_k 'lvdemo' 'a real GUI on that screen (LVGL; mouse works) -- tcc -llvgl'
		_k 'cat x.wav >/dev/dsp' 'sound out of the tab; vol N is the volume knob'
		_k 'nes ROM.nes' 'a NES console -- the screen window pops open, sound and all'
		_k 'nes host / join' '2P netplay over the LAN -- the joiner needs no ROM'
		_k 'bridge start' "a room code; friends 'bridge join' it -- 'bridge say' to chat"
		_k 'alpine' 'apk, a real package manager (needs the relay network)'
		_k 'vim FILE' 'a real vim -- and tcc, make, lua, micropython, qjs'
		_k 'sqlite3, jq' 'data on the shell; curl for the (relay) network'
		printf '\n'
		unset -f _f _k
		;;
esac
