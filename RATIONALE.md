# Engineering Rationale

<!--
  SCAFFOLD - delete this comment block before shipping.

  The five questions below are verbatim from the brief. Write the answers yourself, in your own words.
  Claude has not drafted them and will not: the brief says "answer these in your own words, specific to your
  implementation", the rubric puts 40% on whether the reasoning is genuinely yours, and you will be asked to
  expand on each one live.

  Facts, numbers and file references for each: _brief/rationale-evidence.md (gitignored). It also flags what
  NOT to claim per question, which is worth reading first.

  Length: "a few sentences each" is the brief's own instruction. Roughly 80-150 words per answer. An answer
  you can extend under questioning beats a complete one you cannot.

  Question (b) explicitly asks you to point to the relevant code. Cite file paths.
-->

Answers to the five questions in the brief, for the Inbound Triage Assistant. Setup and known issues are in
the [README](README.md).

## a. Data and taxonomy

> Why you chose these categories and priority definitions, and how your data model would hold up if the
> taxonomy doubled.

_Your answer._

## b. Reliable structure

> How you got consistent structured output from the LLM, and what your code does when the model returns
> something malformed. (Point to the relevant code.)

_Your answer._

## c. Where the model was wrong

> One concrete case where the LLM mis-triaged a message, and how you detected or handled it.

_Your answer._

## d. Edge cases

> Which inputs you treated as malformed / low-signal, what your tool does with them, and why you chose that
> behavior.

_Your answer._

## e. Scale and risk

> What would break if this ran on 10,000 messages a day, and the biggest risk in shipping this to a real
> advisory firm (plus how you'd mitigate it).

_Your answer._
