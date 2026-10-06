# PayMongo integration prerequisites (T06)

Reviewed **2026-10-06** against official public documentation. This is a design
and prerequisite review, not an account activation or sandbox acceptance test.
H03 account/business/Platforms status is unconfirmed; the setup question is
pending. No PayMongo credentials were read, no provider resources created, and
no payment or refund requests made.

## Decision and activation gate

Keep hosted online checkout and pay-on-arrival in the MVP. One booking pays one
venue, including a group booking. PicklyPH takes zero commission; the venue
absorbs processing costs. The server calculates integer PHP centavos from the
booking snapshot. Keep online payment disabled per venue until its provider
relationship, payment capabilities, settlement destination and refund funding
are verified. App ownership verification alone does not activate payments.

PayMongo recommends Checkout v2 for new integrations. Its current split-payment
guide also says payment splitting is being replaced by payout Workflows, with
existing Payment Intent integrations continuing to work. Public docs therefore
do **not** establish an approved new-account marketplace route for PicklyPH.
H03 must obtain the account-specific route before T34 implements it.
[Hosted Checkout](https://docs.paymongo.com/docs/payment-channels-hosted-checkout),
[Payment splitting](https://docs.paymongo.com/docs/payment-acceptance-payment-splitting)

## Documented API paths and unresolved compatibility

All paths below use `https://api.paymongo.com`. Authenticate from the backend
using HTTP Basic with the secret key as username and an empty password.
The official quick start requires a KYC-completed account and a test secret key.
[Checkout quick start](https://docs.paymongo.com/docs/payment-channels-hosted-checkout-quick-start)

| Operation | Public documentation | PicklyPH implementation gate |
| --- | --- | --- |
| Create hosted checkout | `POST /v2/checkout_sessions`; payment intents are created at payment attempt time. | Preferred new checkout version; confirm marketplace routing and response schema with H03. |
| Legacy checkout creation | `POST /v1/checkout_sessions`; creates the intent upfront. | Use only if PayMongo explicitly enables this complete marketplace route for us. |
| Retrieve checkout | `GET /v1/checkout_sessions/{id}`. | Public reference does not prove retrieval of a v2-created session; obtain the compatible contract. |
| Expire checkout | `POST /v1/checkout_sessions/{id}/expire`. | Same cross-version question; do not invent `/v2/.../expire`. |
| Refund payment | Refund guide uses `POST /v1/refunds`; create-refund reference displays `/refunds`. | Resolve this documentation discrepancy and account authorization before coding. |
| Register webhook | `POST /v1/webhooks`. | Separate HTTPS endpoint configuration and signing secret per environment. |

[Legacy create](https://docs.paymongo.com/reference/create-a-checkout),
[Retrieve](https://docs.paymongo.com/reference/retrieve-a-checkout),
[Expire](https://docs.paymongo.com/reference/expire-a-checkout-session),
[Refund guide](https://docs.paymongo.com/docs/payment-acceptance-refunds),
[Refund reference](https://docs.paymongo.com/reference/create-a-refund),
[Webhook setup](https://docs.paymongo.com/docs/developer-tools-webhook-setup-management)

Two settlement candidates require provider approval:

- **Connected-account payment splitting:** activation and merchant relationships
  are required before development. The documented `split_payment.transfer_to`
  route can send the net payment to one child merchant. The older guide says
  that merchant bears the fees and receives the whole net amount when there are
  no recipients. This fits zero commission, subject to new-account availability,
  exact checkout version/payload and test/live enablement. Do not use fixed gross
  splits: oversized splits can leave funds with the creating merchant instead.
  [Legacy split contract](https://developers.paymongo.com/docs/seeds-payment-splitting)
- **Workflow payout routing:** documented workflows compute shares and execute
  separate transfers, commonly after `payout.deposited`. This is a payout-stage
  process, not proof that a paid checkout has settled to a venue. H03 must confirm
  booking-to-venue attribution, partial transfer recovery, refund recovery after
  transfer, fee ownership, access and settlement timing. Do not combine this
  model's funding rules with legacy `split_refund` semantics.
  [Workflow payout splitting](https://docs.paymongo.com/docs/fiaas-workflows-split-a-payout)

## Account, merchant and settlement prerequisites

PayMongo Platforms supports merchant onboarding, connected accounts and payment
distribution; a normal merchant account alone is not evidence of Platforms
access. Ask PayMongo for its supported onboarding API/hosted-onboarding contract
and pilot venue eligibility. [PayMongo Platforms](https://www.paymongo.com/products/platform)

H03 owns platform and venue verification: legal account type, KYC, business
documents, authorized representative, online presence and enabled payment
methods. Follow each account's Dashboard/provider instructions. For a Philippine
sole proprietor, the public requirements include DTI registration, owner ID and
BIR Form 2303; other entity types have different requirements. Submit these
directly to PayMongo, not to this repository or chat.
[Verification requirements](https://docs.paymongo.com/docs/account-settings-verification-requirements),
[Philippine entity documents](https://docs.paymongo.com/re/docs/account-settings-philippine-entities)

Current bank guidance defaults settlement to a PayMongo Wallet; bank routing and
external transfers depend on account type and verification. H03 must establish
the venue's wallet/bank destination, settlement schedule, reserves, transfer
fees and suspended-merchant behavior. Do not promise immediate bank settlement
from a payment-success event.
[Bank configuration](https://docs.paymongo.com/docs/money-movement-bank-configuration)

## Booking, checkout expiry and late payment

The following are **PicklyPH requirements**, not provider guarantees:

1. Reserve inventory transactionally. Approval requests hold for at most two
   hours, capped at play start. Acceptance of an online request, or an instant
   online booking, starts `expires_at = min(now + 15 minutes, play start)`.
2. Create checkout through a server command with a stable attempt ID and
   immutable price, venue, currency and policy snapshots. Return only the hosted
   URL to the app. Explicitly keep `pass_on_fees` false; never copy the guide's
   customer-fee example into our flow. Persist session/intent/payment IDs as they
   become available; v2 need not have an intent at session creation.
3. Reuse the attempt on client retries. An uncertain provider response remains
   reconcilable; do not blindly create a second checkout. Persist our own command
   idempotency and provider request identity. The provider documents
   `Idempotency-Key`, but H03 must confirm endpoint coverage and retention.
   [Provider idempotency](https://docs.paymongo.com/docs/developer-tools-best-practices-1)
4. Supabase governs hold expiry. Release expired allocations under the same
   database locks used by confirmation, cancellation and new reservations.
   Create a durable provider-expiration job for every still-open checkout.
   Retry failed expiration independently; never extend a booking merely because
   PayMongo is unavailable. Availability must exclude elapsed holds even if the
   scheduled job is late.
5. A verified paid event confirms only the matching, still-valid allocation.
   Check provider account/environment, payment status, PHP currency, exact gross
   amount, stored session/attempt and booking before applying a state change.
   Repeated events and different events for the same payment must not confirm or
   charge twice. Success/cancel redirects and closing the browser are navigation
   signals; confirmation comes from server-verified payment state.
6. If payment arrives after cancellation, hold expiry or inventory release,
   record it and enqueue a full gross refund; never revive the booking. Resolve
   simultaneous expiry/payment by transaction locks and one terminal allocation
   outcome. Duplicate successful payments also require compensation. Failed or
   unfunded refunds remain visible for operations and retry/reconciliation.

Provider checkout sessions remain active until explicitly expired; there is no
automatic 15-minute checkout lifetime. Expiration alone is not proof that an
already-started payment cannot settle. H03 must verify in-flight behavior for
each enabled rail and the selected API version.
[Checkout lifecycle and fees](https://docs.paymongo.com/docs/payment-channels-key-concepts)

## Signed webhooks and reconciliation

Use the detailed setup contract: `Paymongo-Signature` contains `t`, `te` and `li`.
Compute HMAC-SHA256 over timestamp text + `.` + the untouched raw body, using the
endpoint signing secret. Select `te` or `li` from the server's expected mode,
then validate the payload mode. Compare decoded signatures in constant time;
reject malformed headers/lengths before comparing. Never reserialize the body.
[Signature procedure](https://docs.paymongo.com/docs/developer-tools-webhook-setup-management)

Subscribe to `checkout_session.payment.paid`, plus `payment.refunded` and
`payment.refund.updated` for refunds where supported. Add settlement/onboarding
events required by the chosen route. Persist a unique provider event ID and a
durable processing job before acknowledging with 2xx JSON. Reconciliation must
retrieve unresolved payment/refund/settlement resources: delivery retries are
finite and missed events while disabled are not automatically replayed.
[Webhook resource and retries](https://docs.paymongo.com/reference/webhook-resource)

**Contract discrepancies to resolve in H03/T35:** the generic best-practices
example hashes only the body, while the detailed setup requires the timestamp
prefix; another guide mentions `X-Paymongo-Signature`. Use the detailed contract
as the candidate and confirm actual headers/signed fixtures in the selected
environment. The hosted guide and quick start also show different event envelope
shapes. Store versioned fixtures before implementing a strict parser. A proposed
five-minute timestamp tolerance is our replay policy, not a documented provider
value; verify retry timestamp behavior before enforcing it.
[Generic example](https://docs.paymongo.com/docs/developer-tools-best-practices-1),
[Alternate header example](https://docs.paymongo.com/docs/payment-acceptance-best-practices)

## Full refunds, fees and funding

Our cancellation policy returns the full booking price at least 24 hours before
play, refunds venue cancellations in full, and gives no automatic player refund
inside 24 hours. Groups cancel/refund together. Late or duplicate payments are
separate compensation cases and must be refunded irrespective of that window.

Refunds use the original payment ID and gross centavo amount, less any previous
successful refund. Track requested/pending/processing/succeeded/failed separately
from booking cancellation. Provider `succeeded` means the refund reached its
payment partner; customer credit timing varies. Never show a requested refund
as money already received. [Refund states](https://docs.paymongo.com/reference/refund-resource)

The refund guide says insufficient payout balance prevents a request and paid-out
transactions use a subsequent payout. It lists card eligibility at 60 days,
GCash at 180, and QR Ph/BPI at 30; UBP cannot be refunded through this flow.
Those windows can conflict with our 60-day booking horizon. H03 must approve a
method/lead-time policy and refund funding before activation, including a safety
margin and the latest venue-cancellation time. Do not enable every checkout
method or assume payout reserves eliminate refund-window limits.
[Refund restrictions](https://docs.paymongo.com/docs/payment-acceptance-refunds)

For the legacy split model, default refunds charge recipients proportionally
to the original split, and `split_refund.refund_sources` can override funding.
Refund obligations are gross, even though venue proceeds were net of fees.
[Split refund rules](https://docs.paymongo.com/docs/payment-acceptance-payment-splitting)

**Example, not a fee quote:** a PHP 1,000 booking with an assumed PHP 30 fee gives
the venue PHP 970. A promised full refund is PHP 1,000, requiring PHP 30 beyond
those proceeds if fees are retained. H03 must confirm fee reversibility, which
account can be debited, reserve/top-up procedures, refund-after-transfer handling
and who funds any shortage. PicklyPH does not assume a zero-commission platform
has cash to cover venue refunds. Failed funding requires an audited operations
queue, retry and customer communication; it never becomes a successful refund.

## H03: provider questions and completion evidence

**Owner: project owner, with PayMongo Platforms support and pilot venues.** All
items below remain pending unless account-specific evidence is recorded here.
The owner can send this checklist; T06 does not send messages on their behalf.

| ID | Obtain before payment implementation/activation |
| --- | --- |
| H03-A | Account/business/KYC status, test-key availability, Platforms onboarding access and pilot venue verification requirements. |
| H03-B | Approved new integration: Checkout v2 + Workflow or enabled legacy split checkout; exact create/retrieve/expire/refund endpoints, schemas and versions. |
| H03-C | Zero commission, all net proceeds to the booked venue, venue-paid processing/transfer fees; sandbox proof of routing and split-failure handling. |
| H03-D | Venue settlement destination/timing, reserves and suspension handling; account ownership of payments, refunds and disputes. |
| H03-E | Gross refund funding before/after payout or Workflow transfer, fee reversal policy, top-ups, insufficient balances and supported refund windows/methods. |
| H03-F | Webhook envelope/IDs/signatures, enabled refund and settlement events, retry timestamps and scoped platform-versus-child event delivery. |
| H03-G | Expiration during in-flight wallet/card payment, late success and duplicate payments; idempotency support/retention for creation, expiry, transfer and refund. |

T34/T35 and H09 must exercise the approved route with test credentials: normal
payment, abandoned browser, duplicate commands/events, concurrent expiry/success,
lost provider response, disabled webhook reconciliation, wrong amount/mode,
gross refund, unfunded refund, split/transfer failure and final venue settlement.
Store sanitized evidence and provider answers; no secrets, real payer data or
live charges are required by this documentation task.

## Server configuration reference

Use separate backend deployments for staging/test and production/live:

| Name | Purpose |
| --- | --- |
| `PAYMONGO_MODE` | Expected `test` or `live`; reject key/payload mode mismatches. |
| `PAYMONGO_SECRET_KEY` | Environment-specific backend API credential. |
| `PAYMONGO_WEBHOOK_SECRET` | Signing secret for that deployment's webhook endpoint. |

Store venue merchant/account IDs and activation capabilities server-side per
venue, not in one global env variable. These names are configuration references,
not a claim that payment functions exist. Keep secrets out of the mobile root
env, Expo public variables, EAS app config and source control. No mobile PayMongo
public key is needed for server-created hosted checkout. Approved HTTPS return
URLs and their iPhone handoff will be defined/tested with the selected route.
