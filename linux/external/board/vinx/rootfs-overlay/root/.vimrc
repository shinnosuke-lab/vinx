" Vim sources $VIMRUNTIME/defaults.vim whenever it finds no *user* vimrc --
" a system vimrc does not count -- and this image carries no runtime, so
" without this file every start ends in "E1187: Failed to source
" defaults.vim". Existing is this file's whole job; the actual settings live
" in the system vimrc, /usr/share/vim/vimrc.
