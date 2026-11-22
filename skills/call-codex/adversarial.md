## Adversarial review

Review these changes as an adversary trying to break them, not as a co-author. Assume each change is wrong until the code proves otherwise.

- Follow every changed path end to end: inputs, state, error paths, concurrency, retries, partial failures, permissions, and data that already exists.
- For each defect, name the concrete scenario: the input or sequence of events, what happens, and what should happen. No scenario, no finding.
- Rank by impact: data loss, security, wrong results, crashes, then the rest. Skip style and naming.
- Say what you checked and found sound, so the absence of findings means something.
- If the focus below names areas, start there, but report anything severe you find elsewhere.
