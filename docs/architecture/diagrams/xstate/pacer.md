# pacer

```mermaid
%% pacer
stateDiagram-v2
  [*] --> ready
  ready --> throttling.applying_retry_after: ACQUIRE_STARTED
  state throttling {
    [*] --> applying_retry_after
    applying_retry_after --> applying_429_backoff: ENTER_429_BACKOFF
    applying_429_backoff --> applying_5xx_backoff: ENTER_5XX_BACKOFF
    applying_5xx_backoff --> applying_token_bucket: ENTER_TOKEN_BUCKET
    applying_token_bucket --> debiting: ENTER_DEBITING
    debiting --> #pacer.ready: ACQUIRE_COMPLETE
  }
```
