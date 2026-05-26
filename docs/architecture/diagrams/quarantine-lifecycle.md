# quarantine-lifecycle

```mermaid
%% quarantine-lifecycle
stateDiagram-v2
  [*] --> quarantined
  quarantined --> pruned: PRUNE
  pruned --> [*]
```
