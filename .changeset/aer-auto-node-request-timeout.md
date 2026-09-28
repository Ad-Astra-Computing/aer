---
'@adastracomputing/aer-auto-node': patch
---

Every request the collector makes to the AER API is now abandoned after 10
seconds. An API that accepted the connection and never answered used to keep
the host process from exiting at all; it now delays exit by up to about 30
seconds, since the last batch, the closing report and the completion are
sent one after another.
