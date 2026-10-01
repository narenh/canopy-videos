# canopy-videos

A small site for sharing YouTube videos and channels. It has no dependencies, uses one Node file, and keeps its data in a JSON file.

- `/` lists channels in a horizontal row of round avatars, with a grid of videos below. Items are sorted by score, highest first, and scores are never shown.
- `/edit` is the admin page, behind a password. Paste one or more YouTube links (videos or channels, in any common URL form, including `?si=` share links) with a score from 0 to 100; the default is 80. Typing `@name` searches YouTube channels as you type.
  - Pasting a link into the empty box adds it immediately.
  - **Paste** reads the clipboard and adds in one tap.
  - Pasting a link that is already saved updates its score.
  - An optional note can be added to videos, either in the add form (set it before pasting) or with the ✎ button on each video. Notes show under the video on `/`.
  - Scores can be edited and items deleted from the lists below the box.

## Deploy (Coolify)

- Build pack: **Dockerfile**
- Port: **3000**
- Persistent storage: a volume mounted at **`/data`**
- Environment:
  - `ADMIN_PASSWORD` (required; `/edit` is disabled without it)

Data is stored in `/data/db.json`. Channel avatars are cached in `/data/avatars/`. Video thumbnails load from `i.ytimg.com`.

The login cookie lasts a year. Changing `ADMIN_PASSWORD` signs out every device.

## Local

```sh
npm run dev   # http://localhost:3000, password "dev", data in ./data
```
