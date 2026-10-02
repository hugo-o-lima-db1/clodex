# Local systemd units

Two things keep the patched Claude Code in step without anyone running a command.

| Unit | Fires on | Runs |
|---|---|---|
| `clodex-auto-patch.path` | any change under `~/.local/share/claude/versions` | `scripts/auto-patch.sh` |
| `clodex-auto-update.timer` | daily, 04:35 | `scripts/auto-update.sh`, which ends by calling `auto-patch.sh` |

Claude Code updates itself at any hour and the launcher starts the newest build,
so the patch has to follow the directory rather than the clock — the path unit is
what removes the "patch it again" chore after every update. The daily timer covers
the other half: a rebuilt clodex changes the patch config hash, which makes the
binary stale even when Claude Code has not moved.

Install (paths inside the units are absolute — edit them if your home differs):

```sh
cp scripts/systemd/clodex-auto-*.{service,path,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now clodex-auto-patch.path clodex-auto-update.timer
```

Logs: `~/.local/state/clodex-auto-patch.log` and `~/.local/state/clodex-auto-update.log`.
