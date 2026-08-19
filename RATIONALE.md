# Engineering Rationale

Answers to the five questions in the brief, for the Inbound Triage Assistant. Setup and known issues are in
the [README](README.md).

## a. Data and taxonomy

> Why you chose these categories and priority definitions, and how your data model would hold up if the
> taxonomy doubled.

_I chose these categories from the perspective of the client's use case. The triage is meant to capture leads, and quickly understand the triage labeling. I chose prospect, existing_client, compliance, fraud_risk, unknown and junk. prospect is new leads, existing_client is existing leads, compliance is legal/regulatory correspondence, fraud_risk are patterns flagged as malicious, unknown is when it doesn't fit cleanly into a single category, and junk is a catchall for spam/adverts/notifications/etc. Priorities are simply high, medium and low, prospect and existing client always get at least a medium priority. I chose these priorities to keep the UX simple and easily understood. If the taxonomy doubles, it would create more category or priority rows. The llm would pick up the distinction, however the deterministic regex system would need to be trained in the new categories. Which isn't a deal-breaker. Custom labels would be read by the llm and sorted accurately most of the time, just not with the guard of the regex rules._

## b. Reliable structure

> How you got consistent structured output from the LLM, and what your code does when the model returns
> something malformed. (Point to the relevant code.)

_We specifically use models with the structured output capability through OpenRouter (see src/llm/client.ts) and then apply a strict JSON schema so we get the appropriate output (see src/triage/schema.ts). Then of course it's verified in code (see validate.ts); if it doesn't verify cleanly, it gets rejected, and walks down the model chain we have set up for OpenRouter, going to the next available model (see retry.ts). A malformed response never gets categorized._

## c. Where the model was wrong

> One concrete case where the LLM mis-triaged a message, and how you detected or handled it.

_Originally I was using a llama 8b model, because I am trying to create the best product with the lowest needed token cost. We had a situation in message 3, where the regex rules were confident of the correct category 'junk' but the model disagreed, and even though it was fed the reasons for the regex rule suggestion (the phrase 'we sell') the model categorized this into a prospect, which was incorrect, and the reconciliation took the model's ruling. The fix was to use the weights on the regex rules, and anything equal to or greater than 4 in the regex pattern match over-ruled the model. A bump of the default model to a llama 70b model made this a failsafe, but the 70b model didn't make the same mistakes._

## d. Edge cases

> Which inputs you treated as malformed / low-signal, what your tool does with them, and why you chose that
> behavior.

_Messages 10 and 11 had unparseable inputs. The tool doesn't waste a call if it cannot be parsed, so it gets rejected at the regex pattern matching phase. I chose this behavior because having a couple of guards in place prevents wasting llm calls, and a message with these patterns will always be invalid. These messages are labeled 'junk' and show the reason for the label as well. One interesting note, message 11 has a body that reads as an illegal JSON escape, so strict parsing of the entire data file that was provided would have thrown and produced zero messages. However, this was caused by a single sender with garbled data, and should never cause the whole system to fail. This is solved by fixing the JSON before parsing, but keeping the original data intact. This is what allowed it to be seen. Message 9 was low-signal; without context impossible to tell what category it belongs in. It is properly classified as unknown with a medium priority, since it could be a customer._

## e. Scale and risk

> What would break if this ran on 10,000 messages a day, and the biggest risk in shipping this to a real
> advisory firm (plus how you'd mitigate it).

_Well first of all we would be bottlenecked by the single queue process. For the process I would have worker threads spin up at a certain threshold, and offload from a shared job table queue. 10,000 requests per day can be handled by our llm, but a burst all at once would be an issue for per minute limits. Failed messages would go into a retry queue, and backlog again. We would need to put a clock on the retry queue so the messages go through at the proper speed. In my opinion, the biggest risk to shipping this to an advisory firm today is that the sample size is too small of those 13 messages to actually determine a great regex pattern match for most messages they may receive. The llm still works well, but would work better with the second system in place well calibrated to the firm. A decent discovery phase would also be preferred, where we can capture the categories they would like triaged into, what their goals are, their ICP, etc, so we can custom tune it to them._
