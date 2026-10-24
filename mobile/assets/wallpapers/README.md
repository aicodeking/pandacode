# Wallpapers

Copies of the desktop's 21 built-in scenes, `public/wallpapers/*.webp`, and their 512 px
previews, `public/wallpapers/thumbnails/` (original PandaCode artwork; see `docs/wallpapers.md`
and `docs/wallpaper-prompts.json`). Keep them byte-identical: when the desktop's scenes change,
copy them here again. `src/ui/Backdrop.tsx` requires each file statically.
