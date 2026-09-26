# Crown Poker

Play-money No-Limit Texas Hold'em in the browser. The whole game is in `index.html` (about 1.5 MB); there is nothing to build or install.

## Put it online with GitHub and Render

1. On GitHub, create a new repository (for example `crown-poker`).
2. Choose **uploading an existing file** and drag in `index.html`, `render.yaml` and this `README.md`. Commit.
3. On Render, choose **New → Blueprint**, connect your GitHub account and pick the repository. Render reads `render.yaml`. Click **Apply**.
4. After about a minute the site is live at `https://crown-poker.onrender.com`, or a similar address if that name is taken.

Alternative to step 3: **New → Static Site**, pick the repository, leave **Build Command** empty and set **Publish Directory** to `.`.

To update the game later, replace `index.html` in the repository. Render redeploys automatically.

Player progress (bankroll, stats, settings) is saved in each visitor's own browser.
