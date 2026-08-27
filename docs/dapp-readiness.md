# dApp readiness report

Generated 2026-08-27T21:56:34.874Z against **Preprod**. Produced by `bun run test:dapp` (`scripts/dapp-readiness.mjs`), read-only.

**Score: 12% on chain** — 4 live, 23 wired-but-unproven, 6 not implemented.

Grades: **live** = proven by an on-chain artifact; **wired-but-unproven** = code path exists but nothing on chain demonstrates it; **not implemented** = absent.

## 1. Contracts compile and match the pinned blueprints

| | Item | Evidence |
| --- | --- | --- |
| WARN | contracts/vault — aiken check | aiken toolchain not installed here; CI runs it on every push |
| WARN | contracts/susdr-vault — aiken check | aiken toolchain not installed here; CI runs it on every push |
| WARN | contracts/multi-asset-vault — aiken check | aiken toolchain not installed here; CI runs it on every push |
| PASS | pinned blueprint hashes vs plutus.json | all pins match a clean build |

## 2. Pinned scripts on Preprod

| | Item | Evidence |
| --- | --- | --- |
| WARN | yield_vault / sfm-01 | derived 15c4fb66817b2c000b8331f665a2dc165eeff6c13e1f4ca06b25dc61 — never seen on chain (addr addr_test1wq2uf7mxs9ajcqqtsvclvedzmst9amlkcylp7n9qdvjaccgr829tl) |
| WARN | vault / sfm-01 | derived 5b3b7e522cab043d8ee88f065e589fe8a3424b562d7e611e47e97d4e — never seen on chain (addr addr_test1wpdnkljj9j4sg0vwaz8svhjcnl52xsjt2ckhucg7gl5h6ns0yx6va) |
| WARN | yield_vault / ph-solar-01 | hash caff856c166b4ad54e949e2dfd13daff9303ed9f6e289027a5c4402e · on chain · cbor MISMATCH · 3 utxo(s) at addr_test1wr90lptvze45442wjj0zmlgnmtlexqldnahz3yp85hzyqtsqygj9m |
| WARN | vault / ph-solar-01 | derived 57ca4b4ef8ba6df92e61888a02add26102c2a70461ec814ed7f179e4 — never seen on chain (addr addr_test1wptu5j6wlzaxm7fwvxyg5q4d6fss9s48q3s7eq2w6lchneqm4kdvy) |
| WARN | yield_vault / sfm-02 | derived cee72c10fdc6409a31002ee175824542382b60f03ef444d4db109847 — never seen on chain (addr addr_test1wr8wwtqslhrypx33qqhwzavzg4prs2mq7ql0g3x5mvgfs3ch0htln) |
| WARN | vault / sfm-02 | derived 0c4072f71843631d7de60779653a1a867655fe46e8e16067800ae8fc — never seen on chain (addr addr_test1wqxyquhhrppkx8taucrhjef6r2r8v407gm5wzcr8sq9w3lqfetr53) |
| WARN | multi_asset_vault / sfm-01 / ADA | derived 29e207da8e077c95425813ab2fd03aa5e785b2922fdef1d5dd39455b — never seen on chain (addr addr_test1wq57yp763crhe92ztqf6kt7s82j70pdjjghaauw4m5u52kct3tq47) |
| WARN | multi_asset_vault / sfm-01 / USDr | derived 29e207da8e077c95425813ab2fd03aa5e785b2922fdef1d5dd39455b — never seen on chain (addr addr_test1wq57yp763crhe92ztqf6kt7s82j70pdjjghaauw4m5u52kct3tq47) |
| WARN | multi_asset_vault / ph-solar-01 / ADA | derived f758cc8146a8a2539f68844c87e23519ca48bd0d64fb2c0bd0251164 — never seen on chain (addr addr_test1wrm43nypg652y5uldzzyeplzx5vu5j9ap4j0ktqt6qj3zeqy6ansy) |
| WARN | multi_asset_vault / ph-solar-01 / USDr | derived f758cc8146a8a2539f68844c87e23519ca48bd0d64fb2c0bd0251164 — never seen on chain (addr addr_test1wrm43nypg652y5uldzzyeplzx5vu5j9ap4j0ktqt6qj3zeqy6ansy) |
| WARN | multi_asset_vault / sfm-02 / ADA | derived 2cb42d9ea01feb9073184ea3e42728b4397652cf70289176e75393a6 — never seen on chain (addr addr_test1wqktgtv75q07hyrnrp828ep89z6rjajjeacz3ytkuafe8fste5pzt) |
| WARN | multi_asset_vault / sfm-02 / USDr | derived 2cb42d9ea01feb9073184ea3e42728b4397652cf70289176e75393a6 — never seen on chain (addr addr_test1wqktgtv75q07hyrnrp828ep89z6rjajjeacz3ytkuafe8fste5pzt) |
| WARN | susdr_vault | derived 09c248dd6dfbd4e7115a02241f9f823e940e43cdc863f6dc0b836447 — never seen on chain (addr addr_test1wqyuyjxadhaafec3tgpzg8ulsglfgrjrehyx8akupwpkg3c4u4plc) |

## 3. Reference scripts

| | Item | Evidence |
| --- | --- | --- |
| FAIL | published reference UTxOs unspent | no vault has published reference scripts yet |
| FAIL | sfm-01 reference scripts | none published — every tx must inline the full script |
| FAIL | ph-solar-01 reference scripts | none published — every tx must inline the full script |
| FAIL | sfm-02 reference scripts | none published — every tx must inline the full script |

## 4. Vault state integrity

| | Item | Evidence |
| --- | --- | --- |
| PASS | sfm-01 state UTxO | 1 datum-bearing utxo(s) of 1 at addr_test1wzu3553l3sh6ptgnmprvejw0dzgmugs06dxz6p9alrg0yqsgd9h47 · bootstrap 929444ef0eea5c29fd216e880592e07632f4be4a22bd2f2ad0ac84f1eb387f27 |
| WARN | ph-solar-01 state UTxO | 3 datum-bearing utxo(s) of 3 at addr_test1wr90lptvze45442wjj0zmlgnmtlexqldnahz3yp85hzyqtsqygj9m · bootstrap 7ace1152a3d49f8692d77823f9c4e532d2254c179e05670d5143cd4e4a9ce28e |
| PASS | sfm-02 state UTxO | 1 datum-bearing utxo(s) of 1 at addr_test1wr8wwtqslhrypx33qqhwzavzg4prs2mq7ql0g3x5mvgfs3ch0htln · bootstrap 661b36317f1de360f3c1f1a9a3f48cc53f0efbe1bc365892fd1d9b9d3287d1aa |

## 5. End-to-end flow coverage (real Preprod transactions)

| | Item | Evidence |
| --- | --- | --- |
| PASS | bootstrap | sfm-01: 929444ef0eea5c29fd216e880592e07632f4be4a22bd2f2ad0ac84f1eb387f27 \| ph-solar-01: 7ace1152a3d49f8692d77823f9c4e532d2254c179e05670d5143cd4e4a9ce28e \| sfm-02: 661b36317f1de360f3c1f1a9a3f48cc53f0efbe1bc365892fd1d9b9d3287d1aa |
| WARN | deposit | builder exists, no recorded Preprod tx |
| WARN | withdraw | builder exists, no recorded Preprod tx |
| WARN | yield | builder exists, no recorded Preprod tx |
| WARN | accrue yield | no accrual tx recorded |
| WARN | set fee / settle fee | fee schedule never signed on chain |
| WARN | governance execution | 0 proposal(s) recorded, none carries an on-chain execution tx — voting and execution are off-chain |
| FAIL | multi-asset deposit (native token) | multi_asset_vault is derivation-only: no tx builder, no adapter, not reachable from the deposit flow |
| FAIL | transferable share tokens | receipts are vault-bound; no CIP-113 style transferable share token |

## Derived script addresses

| Script | Hash | Address |
| --- | --- | --- |
| yield_vault / sfm-01 | `15c4fb66817b2c000b8331f665a2dc165eeff6c13e1f4ca06b25dc61` | `addr_test1wq2uf7mxs9ajcqqtsvclvedzmst9amlkcylp7n9qdvjaccgr829tl` |
| vault / sfm-01 | `5b3b7e522cab043d8ee88f065e589fe8a3424b562d7e611e47e97d4e` | `addr_test1wpdnkljj9j4sg0vwaz8svhjcnl52xsjt2ckhucg7gl5h6ns0yx6va` |
| yield_vault / ph-solar-01 | `caff856c166b4ad54e949e2dfd13daff9303ed9f6e289027a5c4402e` | `addr_test1wr90lptvze45442wjj0zmlgnmtlexqldnahz3yp85hzyqtsqygj9m` |
| vault / ph-solar-01 | `57ca4b4ef8ba6df92e61888a02add26102c2a70461ec814ed7f179e4` | `addr_test1wptu5j6wlzaxm7fwvxyg5q4d6fss9s48q3s7eq2w6lchneqm4kdvy` |
| yield_vault / sfm-02 | `cee72c10fdc6409a31002ee175824542382b60f03ef444d4db109847` | `addr_test1wr8wwtqslhrypx33qqhwzavzg4prs2mq7ql0g3x5mvgfs3ch0htln` |
| vault / sfm-02 | `0c4072f71843631d7de60779653a1a867655fe46e8e16067800ae8fc` | `addr_test1wqxyquhhrppkx8taucrhjef6r2r8v407gm5wzcr8sq9w3lqfetr53` |
| multi_asset_vault / sfm-01 / ADA | `29e207da8e077c95425813ab2fd03aa5e785b2922fdef1d5dd39455b` | `addr_test1wq57yp763crhe92ztqf6kt7s82j70pdjjghaauw4m5u52kct3tq47` |
| multi_asset_vault / sfm-01 / USDr | `29e207da8e077c95425813ab2fd03aa5e785b2922fdef1d5dd39455b` | `addr_test1wq57yp763crhe92ztqf6kt7s82j70pdjjghaauw4m5u52kct3tq47` |
| multi_asset_vault / ph-solar-01 / ADA | `f758cc8146a8a2539f68844c87e23519ca48bd0d64fb2c0bd0251164` | `addr_test1wrm43nypg652y5uldzzyeplzx5vu5j9ap4j0ktqt6qj3zeqy6ansy` |
| multi_asset_vault / ph-solar-01 / USDr | `f758cc8146a8a2539f68844c87e23519ca48bd0d64fb2c0bd0251164` | `addr_test1wrm43nypg652y5uldzzyeplzx5vu5j9ap4j0ktqt6qj3zeqy6ansy` |
| multi_asset_vault / sfm-02 / ADA | `2cb42d9ea01feb9073184ea3e42728b4397652cf70289176e75393a6` | `addr_test1wqktgtv75q07hyrnrp828ep89z6rjajjeacz3ytkuafe8fste5pzt` |
| multi_asset_vault / sfm-02 / USDr | `2cb42d9ea01feb9073184ea3e42728b4397652cf70289176e75393a6` | `addr_test1wqktgtv75q07hyrnrp828ep89z6rjajjeacz3ytkuafe8fste5pzt` |
| susdr_vault | `09c248dd6dfbd4e7115a02241f9f823e940e43cdc863f6dc0b836447` | `addr_test1wqyuyjxadhaafec3tgpzg8ulsglfgrjrehyx8akupwpkg3c4u4plc` |

