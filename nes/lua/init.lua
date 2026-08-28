-- Read once at startup (./init.lua first, then lua/init.lua).
-- Everything here is optional; the machine runs fine without the file.

-- How long one serial keystroke holds a button, in frames (60 per second).
-- Only serial input needs this; evdev input has real press and release.
nes.hold_frames = 6

-- nes.frameskip = -1   -- -1 automatic; 1 = paint every 2nd frame, and so on

-- A per-frame hook with full CPU-bus access. Infinite lives in
-- Super Mario Bros, as the classic example:
--
--   emu.on_frame(function(frame)
--     memory.write(0x075A, 9)
--   end)

-- While a game runs, /tmp/nes.ctl takes one Lua line at a time, from the
-- console or from the vinx agent:
--
--   echo 'joypad.hold({start=true}, 10)' > /tmp/nes.ctl
--   echo 'emu.message(("lives: %d"):format(memory.read(0x075A)))' > /tmp/nes.ctl
--   echo 'emu.save("/data/mario.state")' > /tmp/nes.ctl
