# VM fonts

`rootfs-overlay/usr/share/fonts/cjk16.bin` is an LVGL v9 binary font (16 px,
4 bpp, compressed): the full GB2312 repertoire (7096 CJK glyphs and wide
punctuation) from Droid Sans Fallback Full (Apache-2.0, AOSP) plus ASCII
0x20-0x7E from DejaVu Sans (Bitstream Vera license). It ships inside the
rootfs at `/usr/share/fonts/cjk16.bin` and loads at runtime with
`lv_binfont_create("A:/usr/share/fonts/cjk16.bin")`.

Regenerate (needs node + python3, fonts from Debian's
`fonts-droid-fallback` and `fonts-dejavu-core` packages):

```sh
# ranges-cjk.txt = GB2312 codepoints > 0x7E that exist in the font's cmap
# (see git history for the fontTools snippet that derives it)
npx lv_font_conv --size 16 --bpp 4 --format bin \
  --font DejaVuSans.ttf -r 0x20-0x7E \
  --font DroidSansFallbackFull.ttf -r "$(cat ranges-cjk.txt)" \
  -o cjk16.bin
```
