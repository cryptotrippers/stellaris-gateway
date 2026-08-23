/**
 * Plain-language education content for `/learn`. Static data, no fabricated
 * numbers — anything network-specific points at the live status pages.
 */

export interface LearnSection {
  heading: string;
  body: string;
}

export interface LearnTopic {
  slug: string;
  title: string;
  summary: string;
  minutes: number;
  sections: LearnSection[];
}

export const LEARN_TOPICS: LearnTopic[] = [
  {
    slug: "tokenised-vaults",
    title: "What a tokenised real-world asset vault actually is",
    summary:
      "A vault is a smart contract holding pooled funds against one real asset — a solar array, a building, a fleet — with rules nobody can quietly change.",
    minutes: 4,
    sections: [
      {
        heading: "The asset comes first",
        body: "Behind every vault there is a physical thing that produces revenue: panels selling electricity, a building collecting rent, equipment on hire. The vault is only the accounting layer. If the asset stops producing, the vault has nothing to distribute — no amount of on-chain machinery changes that.",
      },
      {
        heading: "The vault is a contract, not a company",
        body: "Deposits sit in a script address governed by published, audited code. Withdrawal rules, the management fee ceiling, and who may accrue yield are all fixed in that code. Changing them requires a governance vote and a new on-chain transaction, both of which are public.",
      },
      {
        heading: "What you are trusting",
        body: "You are trusting three separate things: the code (auditable, hashes published), the legal wrapper that owns the asset (documents filed on the project's page), and the operator reporting real-world performance. The pipeline exists so you can inspect each one before deciding.",
      },
    ],
  },
  {
    slug: "deposits-and-shares",
    title: "How deposits, shares and fees work",
    summary:
      "You deposit funds and receive shares. Shares are a claim on a slice of the vault, not a fixed sum — and the management fee is charged by minting shares, never by moving your funds.",
    minutes: 5,
    sections: [
      {
        heading: "Shares, not balances",
        body: "When you deposit, the vault mints you shares priced at the current ratio of accounted assets to total shares. Later, your shares redeem for that same proportion of whatever the vault holds. If the vault earns, every share is worth more; if it loses, every share is worth less.",
      },
      {
        heading: "The management fee dilutes, it does not withdraw",
        body: "The annual fee — capped at 5.00% a year by the contract — is settled by minting shares to the treasury, prorated by elapsed time. No funds leave the vault when the fee is charged; existing holders are diluted by exactly the fee amount. That makes the fee visible in the share price rather than hidden in a transfer.",
      },
      {
        heading: "Yield is accrued, not promised",
        body: "Real-world revenue reaches the vault through an explicit accrual transaction that raises accounted assets. Any APY you see on this site is either a realised figure computed from those accruals with its timestamp shown, or an explicitly illustrative projection. There is no forecast presented as fact.",
      },
    ],
  },
  {
    slug: "governance",
    title: "What governance actually controls",
    summary:
      "Voters decide which projects get a vault and what fee they charge. Voters cannot move funds out of a vault, and no proposal executes itself.",
    minutes: 4,
    sections: [
      {
        heading: "What a vote can do",
        body: "Governance approves a funding request into an asset, sets or changes a vault's management fee, and pauses or unpauses a vault. Each of these maps to a specific proposal kind and, where relevant, a specific on-chain action.",
      },
      {
        heading: "What a vote cannot do",
        body: "There is no proposal kind that transfers depositor funds to anyone. Withdrawals are always the depositor's own transaction, validated against their own shares.",
      },
      {
        heading: "Passing is not executing",
        body: "A passed proposal is an instruction, not an effect. An operator still has to build, sign and submit the transaction — and until they do, the project page says so plainly.",
      },
    ],
  },
  {
    slug: "preprod",
    title: "Why this runs on Preprod, and what that means for you",
    summary:
      "Everything here is on Cardano's Preprod test network. Test ADA has no market value. Nothing on this site is deployed to mainnet.",
    minutes: 3,
    sections: [
      {
        heading: "Test network, test value",
        body: "Preprod is Cardano's pre-production test network. The tADA used here is free from a faucet and cannot be sold. Deposits, yields and balances on this site are real transactions with unreal money.",
      },
      {
        heading: "Why we are still here",
        body: "The contracts, the fee arithmetic, the governance flow and the reference scripts are the same code that a mainnet deployment would use. Running them publicly on Preprod, with real issuers filing real evidence, is how the pipeline earns the right to hold real capital.",
      },
      {
        heading: "The gate to mainnet",
        body: "The app refuses to resolve mainnet configuration at all — this is enforced in code, not policy. Moving requires an audited release, published reference scripts and a deliberate change, documented on the security page.",
      },
    ],
  },
  {
    slug: "connect-a-wallet",
    title: "Connecting a Cardano wallet safely",
    summary:
      "How to connect, what a connection can and cannot do, and how to be sure you are on the right network before you sign anything.",
    minutes: 4,
    sections: [
      {
        heading: "Connecting is read-only",
        body: "Connecting a CIP-30 wallet lets the site see your addresses and balance so it can build transactions. It cannot move anything. Every state change requires you to review and sign in your wallet.",
      },
      {
        heading: "Check the network before you sign",
        body: "Your wallet must be set to Preprod. The badge in the header shows the network the app detected; if it disagrees with your wallet, signing is blocked rather than risked.",
      },
      {
        heading: "Read the transaction",
        body: "Your wallet shows the exact outputs before you approve. For a deposit, you should see funds going to the vault script address shown on the project page. If the address does not match, do not sign.",
      },
    ],
  },
];

export function findTopic(slug: string): LearnTopic | undefined {
  return LEARN_TOPICS.find((t) => t.slug === slug);
}
