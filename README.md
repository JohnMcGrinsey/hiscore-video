# HISCORE-VIDEO/1.4

The optional video companion package to the [HISCORE protocol](https://github.com/JohnMcGrinsey/hiscore-protocol).

**HISCORE-VIDEO requires HISCORE. HISCORE does not require HISCORE-VIDEO.**

A game on pure HISCORE is complete. This package adds one thing: a recording of the run attached to the score, so a record carries its own footage. A score without a clip is always valid. Never require a clip.

- Spec: [`hiscore-video.txt`](hiscore-video.txt)
- Browser kit: [`hiscore.js`](hiscore.js)
- Live copies: https://gamesareeatingtheworld.com/hiscore-video.txt · https://gamesareeatingtheworld.com/hiscore.js
- The protocol this builds on: https://gamesareeatingtheworld.com/hiscore.txt

## What it adds

- Three optional fields on a score: `proof_url`, `proof_sha256`, `proof_kind` (clip | replay)
- One upload endpoint: `POST /api/scores/<id>/proof` (multipart field `video`, capped at 32 MB on the reference registry)
- The kit `hiscore.js`: the whole protocol client (same `GS.*` calls as `gs.js`) plus a canvas recorder and a share card. `HISCORE.start()` when a run begins, `GS.submit(score)` when it ends. Nothing uploads without an explicit click by the player.

You can also use this package with plain HTTP and no code from us: record however you want and upload the file yourself. The spec has both ways.

## Give this line to your agent

Only if your game is already on HISCORE and you want footage on records:

```
Add the optional HISCORE-VIDEO package to my game: https://gamesareeatingtheworld.com/hiscore-video.txt
My game is already on the HISCORE protocol. A score without a clip stays valid.
```

## Versioning

Versions move in lockstep with the protocol: HISCORE-VIDEO/1.4 pairs with HISCORE/1.4. There is no mixed pairing.

## Change the spec

Open an issue or a pull request.

## Licence

[CC BY 4.0](LICENSE).

Contact: john@mcgrinsey.com

[Legal: Impressum](https://gamesareeatingtheworld.com/de/impressum)
