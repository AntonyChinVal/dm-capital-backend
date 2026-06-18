# qop-terminal-backend

Express gateway between Deribit's public API and the React frontend.

## Run

```bash
pnpm install
pnpm dev             # tsx watch — restarts on file change
```

Default port `4000`. Override via `PORT=… pnpm dev`.

## Endpoints (Phase 0)

| Method | Path | Source |
|--------|------|--------|
| GET | `/api/health` | local |
| GET | `/api/index?name=btc_usd` | `public/get_index_price` |
| GET | `/api/options?currency=BTC` | `public/get_book_summary_by_currency` |

`/api/options` returns:
```json
{
  "currency": "BTC",
  "count": 1247,
  "fetchedAt": 1718524800000,
  "instruments": [ /* raw Deribit book-summary rows */ ]
}
```

## Notes

- Uses Node 20's native `fetch`. No axios.
- No auth — everything is public read-only Deribit data.
- Errors from upstream Deribit are surfaced as HTTP `502` with a JSON `error`
  field.

## Next

Phase 1 will add `src/compute/{oi,ivSurface,maxPain}.ts` so the frontend gets
pre-computed metrics instead of raw rows.
