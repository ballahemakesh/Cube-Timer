# CubeTimer

## Run locally
1. Install Node 18+ and a Postgres database (or use a free Neon/Supabase one).
2. `npm install`
3. `DATABASE_URL="postgres://user:pass@localhost:5432/cubetimer" JWT_SECRET="any-long-random-string" npm start`
4. Open http://localhost:3000

## Deploy on Render (data survives restarts and redeploys)
Render's free web service has a temporary disk, so accounts must live in an outside database.
1. Create a free Postgres database at neon.tech (or supabase.com) and copy its connection string.
2. Push this folder to a GitHub repo.
3. On Render: New > Web Service > pick the repo. Build command `npm install`, start command `npm start`.
4. Add environment variables: `DATABASE_URL` (the connection string) and `JWT_SECRET` (a long random string).
5. Deploy. Tables are created automatically on first start.
