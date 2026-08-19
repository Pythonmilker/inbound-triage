# eval/

Two sets of messages, and the difference between them is the whole point.

| file | what it is | what it measures |
|---|---|---|
| `../raw/inbound.json` | the 13 supplied messages | **the training set.** The rule layer's patterns were developed with these in view. |
| `holdout.json` | 16 messages the patterns have never seen | **the test set.** Whether the tuning generalises, or was fitted. |

## Why a second set exists

The deterministic layer scores **6/6 on category and 6/6 on priority** against hand labels on the supplied
queue. On its own that number means very little, because 176 regex patterns were written while looking at
those 13 messages. A model tuned against a sample and then scored on the same sample is being asked to
recognise sentences it was built from.

So the question a reviewer would actually ask — *does the LLM earn its keep, or would rules alone do?* —
cannot be answered on the supplied queue at all. On that data rules win, and they win partly by
construction.

**Rules and a model fail differently, and that is the thing worth measuring.** A regex fails *silently* on
phrasing it has not seen: it returns `unknown`, contributes nothing, and looks perfectly healthy doing it.
A model fails *confidently*, which is visible. Cold messages are where the first failure mode shows up, and
they are the only place the second half of the reconciliation design has anything to prove.

This mirrors how the same work would be done on real traffic: tune against a training set, then test cold
against unrelated mail. Shipping the first number without the second would be reporting the easy half.

## How the held-out set was built, and what is wrong with it

Phrasings were drawn from **real inbound mail** rather than invented, then transposed into the advisory
domain. Every name, firm, amount, date and account in `holdout.json` is fabricated; no real identifier
appears.

Drawing from real mail mattered more than it sounds. Actual marketing email rarely says *"we sell"*, *"quick
demo"* or *"used by 200+"* — the phrasings the vendor patterns look for. It opens with a benefit claim:
*"Scaling client reporting should not mean adding staff."* A set written from imagination would have
reproduced the patterns' own assumptions and quietly passed.

**The set is still author-biased, and that is a real limitation.** The same author wrote the 176 patterns and
these 16 messages, so it is possible to write mail that dodges the patterns or that flatters them without
intending either. Three things bound it, none completely:

- messages derived from scenarios and real phrasings, not from reading the patterns;
- labels written blind and committed **before** the first run, so nothing can be tuned afterwards;
- the two guard categories included, having never been exercised on any text at all.

The strongest version of this test uses real mail, or messages written by someone who has not seen the
patterns. Treat the number this produces as directional.

## What is deliberately in the set

Sixteen messages across all six categories, weighted toward cases that are hard rather than
representative — a test set of easy rows measures nothing:

- **money and life events with no keyword**: an estate settling, a planned retirement, a 403(b) rollover
- **service requests with no self-identification**: a third party waiting on a document, an unexplained line
  on a statement
- **a soft attrition signal**, phrased as a courtesy rather than a threat
- **marketing in benefit-claim voice**, which the vendor patterns were not written for
- **a recruiter pitching a candidate to the firm** rather than a role to the reader
- **an automated billing notice** phrased as a notification, not a demand
- **two genuinely ambiguous rows** where reasonable people would disagree, included so the confidence
  numbers have something to be uncertain about
- **the two guards**: a payment redirect phrased politely, and an auditor's confirmation request
- **one prompt injection**, to check that an instruction aimed at the model is treated as a fact about the
  message rather than followed

One pair is deliberately linked: the same sender appears in the attrition note and in the bank-change
request. Whether that ordering should change the second verdict is a judgement, and it is the kind of thing
a real desk would notice and a per-message classifier will not.

## Running it

Labels first, always. Reading the candidates before writing a label is the same anchoring effect this eval
exists to measure, applied to the labeller.

```bash
pnpm eval --queue eval/holdout.json --labels eval/holdout-labels.json --label-all --out eval/holdout-report.md
```

`--label-all` matters: the default stubs only the rows where something disagreed, which is right for the
training set and wrong here. Accuracy over just the disagreeing rows is accuracy over a biased subset.

## Reading the result honestly

- **Rules hold up on cold mail** → the deterministic layer generalises, and the model's contribution is the
  written summary plus coverage of whatever the patterns still miss. Say that plainly.
- **Rules degrade and the model does not** → reconciliation is carrying real weight, and the two-layer design
  is doing what it was built for.
- **Both degrade** → the taxonomy or the labels need work before either layer is the problem.

A gap of one row is roughly six points on sixteen messages. Read the percentages as counts.
