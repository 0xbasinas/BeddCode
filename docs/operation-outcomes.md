# Mutation outcomes after a lost response

Session notes saves carry a client-generated operation ID, kept with the local draft until the host answers. The host stores the ID in the same durable event as the new notes. On reconnect the client asks for that receipt; a matching event confirms the saved text and version, even after a host restart. Reusing an ID with different content is rejected. Older clients can still save without an ID.

A missing receipt does not prove failure: the request could still be in flight, the host may be older, or history could have been removed. The draft stays available and the user must compare it with the current notes before another save. The receipt lasts only as long as the session history. This is not an offline queue; no save is sent automatically after reconnect.

Other mutations do not have durable receipts in this version. In particular, a lost Git commit or push response is shown as an unknown outcome. Check the local repository and, for pushes, the remote before deciding what to do. External effects need their own checks; a stored host receipt alone cannot guarantee exactly-once execution. Other screens may still report transport errors without reconciliation and should be handled in follow-up work.
