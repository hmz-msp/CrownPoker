# Crown Poker (online)

Play-money No-Limit Texas Hold'em. Play against computer opponents, or create a private room and play your friends online in real time.

## Files

- `public/index.html` – the whole game client
- `server.mjs` – the game server: serves the page and runs private rooms over WebSockets (Socket.IO)
- `package.json` – one dependency (`socket.io`)
- `render.yaml` – Render settings

## Put it online with GitHub and Render

1. On GitHub, create a new repository (or reuse your old one and delete its old files).
2. Choose **uploading an existing file**. Drag in the `public` folder, `server.mjs`, `package.json`, `render.yaml` and this README. Commit.
3. On Render, choose **New → Blueprint**, pick the repository and click **Apply**. Render reads `render.yaml` and creates a **Web Service** called `crown-poker-online`.
4. When the deploy finishes (2–3 minutes), open the address Render shows, such as `https://crown-poker-online.onrender.com`.

Alternative to step 3: **New → Web Service**, pick the repository, set Build Command `npm install --omit=dev` and Start Command `npm start`.

A Render **Static Site** can't run the room server, so private rooms need this Web Service. If you still have the earlier static site, you can delete it.

## Playing with friends

- **Host:** Tables → Private Table → Create Room. Send the 6-character code to your friends. When at least 2 players are seated, press **Start Game**.
- **Friends:** open the same address, then Tables → Private Table → Join Room. Enter the code and a name, then press **Join Table**.

Up to 2, 6 or 9 players per room, depending on the table size the host picked. If you refresh the page or lose connection, you return to the same seat. Room chips are separate from your bankroll.

## Good to know

- The server deals every card and decides every pot. Browsers only send actions, and each player receives only their own hole cards.
- On Render's free plan the service sleeps after about 15 minutes with no visitors. The first visit afterwards takes about a minute to wake it, and rooms that were open are lost when it sleeps or redeploys. A paid instance stays awake.
