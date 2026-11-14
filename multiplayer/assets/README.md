# Optional authored character

Default gameplay needs no external character file. To enable an authored body,
place an appropriately licensed `custom-soldier.glb` or self-contained
`custom-soldier.gltf` in this directory, then open the game with
`?multiplayer=1&soldier=glb` or `?multiplayer=1&soldier=gltf`.

The body requires real skinning, metres/feet origin/forward -Z, the seven named
animation clips and four body sockets specified in `../../TACTICAL_SOLDIER.md`.
Export the body/head/gear without duplicate arms or weapons. The game retains
its original PAC-9 and articulated Fh arms. No professional model is included.
