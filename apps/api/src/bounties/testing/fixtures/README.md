# Bounty collection test fixtures

Real captures, fetched 2026-11-27 from the public pages and stored unmodified (gzip-compressed):
- `board-programs-2026-11-27.json.gz`: https://bug-bounty-board.vercel.app/programs.json
- `sherlock-bug-bounties-2026-11-27.html.gz`: https://audits.sherlock.xyz/bug-bounties
- `hackenproof-programs-p1-2026-11-27.html.gz`: https://hackenproof.com/programs (page 1)
- `x-oembed-jack-20.json`: the response of https://publish.x.com/oembed?url=https://x.com/jack/status/20, used to check the oEmbed format only
- `cantina-robots.txt`, `x-robots.txt`: those hosts' robots.txt files

The fixtures make parser tests repeatable. They are not the end-to-end evidence: the live collection runs are recorded in
`docs/bounty-intelligence.md`. Synthetic inputs (roundup pages, X post text) are written inline in the tests and named as synthetic.
