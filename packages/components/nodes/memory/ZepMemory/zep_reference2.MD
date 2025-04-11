SDK Reference User

Delete User
Deletes a user.

DELETE /api/v2/users/ :userId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.delete(
7 user_id="userId",
8 )

200 Deleted

1 {
2 "message": "message" 
3 }

Path parameters

userId string Required 
User ID

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Response
OK

message string Optional

Errors

404 User Delete Request Not Found Error

500 User Delete Request Internal Server Error

Update User Next

Built with


SDK Reference User

Get User
Returns a user.

GET /api/v2/users/ :userId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.get(
7 user_id="userId",
8 )

200 Retrieved

1 {
2 "created_at": "created_at", 
3 "deleted_at": "deleted_at", 
4 "email": "email",
5 "fact_rating_instruction": { 
6 "examples": {
7 "high": "high",
8 "low": "low",
9 "medium": "medium"
10 },
11 "instruction": "instruction" 
12 },
13 "first_name": "first_name", 
14 "id": 1,
15 "last_name": "last_name", 
16 "metadata": {
17 "key": "value"
18 },
19 "project_uuid": "project_uuid", 
20 "session_count": 1,
21 "updated_at": "updated_at",

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


22 "user_id": "user_id", 
23 "uuid": "uuid"
24 }

Path parameters

userId string Required
The user_id of the user to get.

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Response
The user that was retrieved.

created_at string Optional

deleted_at string Optional

email string Optional

fact_rating_instruction object Optional

Show 2 properties

first_name string Optional

id integer Optional

last_name string Optional

metadata map from strings to any Optional


Was this page helpful? Yes No

Previous

Deprecated

project_uuid string Optional

session_count integer Optional 
Deprecated

updated_at string Optional 
Deprecated

user_id string Optional

uuid string Optional

Errors

404 User Get Request Not Found Error

500 User Get Request Internal Server Error

Delete User Next

Built with


SDK Reference User

Get Users
Returns all users.

GET /api/v2/users-ordered Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.list_ordered()

200 Retrieved

1 {
2 "row_count": 1,
3 "total_count": 1, 
4 "users": [
5 {
6 "created_at": "created_at", 
7 "deleted_at": "deleted_at", 
8 "email": "email",
9 "first_name": "first_name", 
10 "id": 1,
11 "last_name": "last_name", 
12 "metadata": {
13 "key": "value"
14 },
15 "project_uuid": "project_uuid", 
16 "session_count": 1,
17 "updated_at": "updated_at", 
18 "user_id": "user_id",
19 "uuid": "uuid"
20 }
21 ] 
22 }

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Query parameters

pageNumber integer Optional
Page number for pagination, starting from 1

pageSize integer Optional
Number of users to retrieve per page

Response
Successfully retrieved list of users

row_count integer Optional

total_count integer Optional

users list of objects Optional

Show 13 properties

Errors

400 User List Ordered Request Bad Request Error

500 User List Ordered Request Internal Server Error


Previous Get User Next

Built with


SDK Reference User

Add User
Adds a user.

POST /api/v2/users Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.add()

201 Created

1 {
2 "created_at": "created_at", 
3 "deleted_at": "deleted_at", 
4 "email": "email",
5 "fact_rating_instruction": { 
6 "examples": {
7 "high": "high",
8 "low": "low",
9 "medium": "medium"
10 },
11 "instruction": "instruction" 
12 },
13 "first_name": "first_name", 
14 "id": 1,
15 "last_name": "last_name", 
16 "metadata": {
17 "key": "value"
18 },
19 "project_uuid": "project_uuid", 
20 "session_count": 1,
21 "updated_at": "updated_at",
22 "user_id": "user_id",
23 "uuid": "uuid"

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


24 }

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

email string Optional
The email address of the user.

fact_rating_instruction object Optional 
Optional instruction to use for fact rating.

Show 2 properties

first_name string Optional 
The first name of the user.

last_name string Optional 
The last name of the user.

metadata map from strings to any Optional 
The metadata associated with the user.

user_id string Optional
The unique identifier of the user.

Response
The user that was added.


created_at string Optional

deleted_at string Optional

email string Optional

fact_rating_instruction object Optional

Show 2 properties

first_name string Optional

id integer Optional

last_name string Optional

metadata map from strings to any Optional 
Deprecated

project_uuid string Optional

session_count integer Optional 
Deprecated

updated_at string Optional 
Deprecated

user_id string Optional

uuid string Optional

Errors

400 User Add Request Bad Request Error

500 User Add Request Internal Server Error


Was this page helpful? Yes No

Previous Get Users Next

Built with


SDK Reference Memory

Delete Session
Deletes a session.

DELETE /api/v2/sessions/ :sessionId /memory Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.memory.delete(
7 session_id="sessionId", 
8 )

200 Deleted

1 {
2 "message": "message" 
3 }

Path parameters

sessionId string Required
The ID of the session for which memory should be deleted.

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Response
OK

message string Optional

Errors

404 Memory Delete Request Not Found Error

500 Memory Delete Request Internal Server Error

Add User Next

Built with


SDK Reference Memory

Add Memory to Session
Add memory to the specified session.

POST /api/v2/sessions/ :sessionId /memory Python

1 from zep_cloud import Message
2 from zep_cloud.client import Zep
3
4 client = Zep(
5 api_key="YOUR_API_KEY", 
6 )
7 client.memory.add(
8 session_id="sessionId", 
9 messages=[
10 Message(
11 content="content",
12 role_type="norole",
13 )
14 ],
15 )

200 Successful

1 {
2 "context": "context" 
3 }

Path parameters

sessionId string Required
The ID of the session to which memory should be added.

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

messages list of objects Required
A list of message objects, where each message contains a role and content.

Show 8 properties

fact_instruction string Optional 
Deprecated

ignore_roles list of enums Optional
Optional list of role types to ignore when adding messages to graph memory. The message itself will 
still be added retained and used as context for messages that are added to a user’s graph.

Show 6 enum values

return_context boolean Optional
Optionally return memory context relevant to the most recent messages.

summary_instruction string Optional 
Deprecated

Response
An object, optionally containing memory context retrieved for the last message

context string Optional


Was this page helpful? Yes No

Previous

Errors

500 Memory Add Request Internal Server Error

Delete Session Next

Built with


SDK Reference Memory

Classify Session
Classifies a session.

POST /api/v2/sessions/ :sessionId /classify Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.memory.classify_session( 
7 session_id="sessionId",
8 classes=["classes"],
9 name="name",
10 )

200 Successful

1 {
2 "class": "class", 
3 "label": "label"
4 }

Path parameters

sessionId string Required 
Session ID

Headers

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

classes list of strings Required
The classes to use for classification.

name string Required
The name of the classifier.

instruction string Optional
Custom instruction to use for classification.

last_n integer Optional Defaults to 4
The number of session messages to consider for classification. Defaults to 4.

persist boolean Optional Defaults to true 
Deprecated

Response
A response object containing the name and classification result.

class string Optional

label string Optional

Errors

404 Memory Classify Session Request Not Found Error

500 Memory Classify Session Request Internal Server Error


Was this page helpful? Yes No

Previous Add Memory to Session Next

Built with


SDK Reference Memory

Get Message
Returns a specific message from a session.

GET /api/v2/sessions/ :sessionId /messages/ :messageUUID Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.memory.get_session_message( 
7 session_id="sessionId",
8 message_uuid="messageUUID",
9 )

200 Retrieved

1 {
2 "content": "content",
3 "role_type": "norole",
4 "created_at": "created_at", 
5 "metadata": {
6 "key": "value"
7 },
8 "role": "role",
9 "token_count": 1,
10 "updated_at": "updated_at", 
11 "uuid": "uuid"
12 }

Path parameters

sessionId string Required

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Soon to be deprecated as this is not needed.

messageUUID string Required 
The UUID of the message.

Response
The message.

content string
The content of the message.

role_type enum
The type of the role (e.g., “user”, “system”).

Show 6 enum values

created_at string Optional
The timestamp of when the message was created.

metadata map from strings to any Optional
The metadata associated with the message.

role string Optional
Customizable role of the sender of the message (e.g., “john”, “sales_agent”).

token_count integer Optional 
Deprecated

updated_at string Optional 
Deprecated

uuid string Optional
The unique identifier of the message.

Errors


Was this page helpful? Yes No

Previous

404 Memory Get Session Message Request Not Found Error

500 Memory Get Session Message Request Internal Server Error

Classify Session Next

Built with


SDK Reference Memory

Get Messages for Session
Returns messages for a session.

GET /api/v2/sessions/ :sessionId /messages Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.memory.get_session_messages( 
7 session_id="sessionId",
8 )

200 Retrieved

1 {
2 "messages": [
3 {
4 "content": "content",
5 "role_type": "norole",
6 "created_at": "created_at", 
7 "metadata": {
8 "key": "value"
9 },
10 "role": "role",
11 "token_count": 1,
12 "updated_at": "updated_at", 
13 "uuid": "uuid"
14 }
15 ],
16 "row_count": 1, 
17 "total_count": 1 
18 }

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Path parameters

sessionId string Required 
Session ID

Query parameters

limit integer Optional
Limit the number of results returned

cursor integer Optional 
Cursor for pagination

Response
OK

messages list of objects Optional 
A list of message objects.

Show 8 properties

row_count integer Optional
The number of messages returned.

total_count integer Optional 
The total number of messages.

Errors

404 Memory Get Session Messages Request Not Found Error

500 Memory Get Session Messages Request Internal Server Error


Was this page helpful? Yes No

Previous Get Message Next

Built with


SDK Reference Memory

Get Session Memory
Returns a memory for a given session.

GET /api/v2/sessions/ :sessionId /memory Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.memory.get(
7 session_id="sessionId", 
8 )

200 Retrieved

1 {
2 "context": "context", 
3 "facts": [
4 "facts"
5 ],
6 "messages": [
7 {
8 "content": "content",
9 "role_type": "norole",
10 "created_at": "created_at", 
11 "metadata": {
12 "key": "value"
13 },
14 "role": "role",
15 "token_count": 1,
16 "updated_at": "updated_at", 
17 "uuid": "uuid"
18 }
19 ],
20 "metadata": {
21 "key": "value"

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


22 },
23 "relevant_facts": [ 
24 {
25 "content": "content",
26 "created_at": "created_at", 
27 "fact": "fact",
28 "uuid": "uuid",

Path parameters

sessionId string Required
The ID of the session for which to retrieve memory.

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Query parameters

lastn integer Optional
The number of most recent memory entries to retrieve.

minRating double Optional
The minimum rating by which to filter relevant facts.

Response
OK

context string Optional
Memory context containing relevant facts and entities for the session. Can be put into the prompt 
directly.

facts list of strings Optional


Was this page helpful? Yes No

Previous

Deprecated: Use relevant_facts instead.

messages list of objects Optional
A list of message objects, where each message contains a role and content. Only last_n messages will 
be returned

Show 8 properties

metadata map from strings to any Optional 
Deprecated

relevant_facts list of objects Optional
Most relevant facts to the recent messages in the session.

Show 11 properties

summary object Optional
Deprecated: Use context string instead.

Show 6 properties

Errors

404 Memory Get Request Not Found Error

500 Memory Get Request Internal Server Error

Get Messages for Session Next

Built with


SDK Reference Memory

Get Sessions
Returns all sessions.

GET /api/v2/sessions-ordered Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.memory.list_sessions()

200 Retrieved

1 {
2 "response_count": 1, 
3 "sessions": [
4 {
5 "classifications": {
6 "key": "value"
7 },
8 "created_at": "created_at", 
9 "deleted_at": "deleted_at", 
10 "ended_at": "ended_at",
11 "facts": [
12 "facts"
13 ],
14 "id": 1,
15 "metadata": {
16 "key": "value"
17 },
18 "project_uuid": "project_uuid", 
19 "session_id": "session_id",
20 "updated_at": "updated_at",
21 "user_id": "user_id",
22 "uuid": "uuid"
23 }

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


24 ],
25 "total_count": 1 
26 }

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Query parameters

page_number integer Optional
Page number for pagination, starting from 1

page_size integer Optional
Number of sessions to retrieve per page.

order_by string Optional
Field to order the results by: created_at, updated_at, user_id, session_id.

asc boolean Optional
Order direction: true for ascending, false for descending.

Response
List of sessions

response_count integer Optional

sessions list of objects Optional

Show 13 properties

total_count integer Optional


Was this page helpful? Yes No

Previous

Errors

400 Memory List Sessions Request Bad Request Error

500 Memory List Sessions Request Internal Server Error

Get Session Memory Next

Built with


SDK Reference Memory

Get Session
Returns a session.

GET /api/v2/sessions/ :sessionId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.memory.get_session(
7 session_id="sessionId", 
8 )

200 Retrieved

1 {
2 "classifications": { 
3 "key": "value"
4 },
5 "created_at": "created_at", 
6 "deleted_at": "deleted_at", 
7 "ended_at": "ended_at",
8 "fact_rating_instruction": { 
9 "examples": {
10 "high": "high",
11 "low": "low",
12 "medium": "medium"
13 },
14 "instruction": "instruction" 
15 },
16 "facts": [ 
17 "facts"
18 ],
19 "id": 1,
20 "metadata": {
21 "key": "value"

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


22 },
23 "project_uuid": "project_uuid", 
24 "session_id": "session_id",
25 "updated_at": "updated_at",
26 "user_id": "user_id",
27 "uuid": "uuid"
28 }

Path parameters

sessionId string Required
The unique identifier of the session.

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Response
The session with the specified ID.

classifications map from strings to strings Optional

created_at string Optional

deleted_at string Optional

ended_at string Optional

fact_rating_instruction object Optional 
Deprecated

Show 2 properties

facts list of strings Optional


Was this page helpful? Yes No

Previous

Deprecated

id integer Optional

metadata map from strings to any Optional 
Deprecated

project_uuid string Optional

session_id string Optional

updated_at string Optional 
Deprecated

user_id string Optional

uuid string Optional

Errors

404 Memory Get Session Request Not Found Error

500 Memory Get Session Request Internal Server Error

Get Sessions Next

Built with


SDK Reference Memory

Add Session
Creates a new session.

POST /api/v2/sessions Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.memory.add_session(
7 session_id="session_id", 
8 user_id="user_id",
9 )

201 Created

1 {
2 "classifications": { 
3 "key": "value"
4 },
5 "created_at": "created_at", 
6 "deleted_at": "deleted_at", 
7 "ended_at": "ended_at",
8 "fact_rating_instruction": { 
9 "examples": {
10 "high": "high",
11 "low": "low",
12 "medium": "medium"
13 },
14 "instruction": "instruction" 
15 },
16 "facts": [ 
17 "facts"
18 ],
19 "id": 1,
20 "metadata": {

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


21 "key": "value"
22 },
23 "project_uuid": "project_uuid", 
24 "session_id": "session_id",
25 "updated_at": "updated_at",
26 "user_id": "user_id",
27 "uuid": "uuid"

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

session_id string Required
The unique identifier of the session.

user_id string Required
The unique identifier of the user associated with the session

fact_rating_instruction object Optional 
Deprecated

Show 2 properties

metadata map from strings to any Optional 
Deprecated

Response
The added session.

classifications map from strings to strings Optional


created_at string Optional

deleted_at string Optional

ended_at string Optional

fact_rating_instruction object Optional 
Deprecated

Show 2 properties

facts list of strings Optional 
Deprecated

id integer Optional

metadata map from strings to any Optional 
Deprecated

project_uuid string Optional

session_id string Optional

updated_at string Optional 
Deprecated

user_id string Optional

uuid string Optional

Errors

400 Memory Add Session Request Bad Request Error

500 Memory Add Session Request Internal Server Error


Was this page helpful? Yes No

Get Session Next

Built with


SDK Reference Graph Node

Get Node
Returns a specific node by its UUID.

GET /api/v2/graph/node/ :uuid Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.graph.node.get(
7 uuid_="uuid",
8 )

200 Retrieved

1 {
2 "created_at": "created_at", 
3 "name": "name",
4 "summary": "summary",
5 "uuid": "uuid",
6 "attributes": {
7 "key": "value"
8 },
9 "labels": [
10 "labels"
11 ] 
12 }

Path parameters

uuid string Required 
Node UUID

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Response
Node

created_at string 
Creation time of the node

name string
Name of the node

summary string
Regional summary of surrounding edges

uuid string
UUID of the node

attributes map from strings to any Optional
Additional attributes of the node. Dependent on node labels

labels list of strings Optional 
Labels associated with the node

Errors

400 Node Get Request Bad Request Error

404 Node Get Request Not Found Error

500 Node Get Request Internal Server Error

Returns a fact by UUID Next


Built with


SDK Reference Graph Node

Get User Nodes
Returns all nodes for a user

GET /api/v2/graph/node/user/ :user_id Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.node.get_by_user_id( 
7 user_id="user_id",
8 )

200 Retrieved

1 [
2 {
3 "created_at": "created_at", 
4 "name": "name",
5 "summary": "summary", 
6 "uuid": "uuid",
7 "attributes": {
8 "key": "value"
9 },
10 "labels": [
11 "labels"
12 ]
13 } 
14 ]

Path parameters

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

user_id string Required 
User ID

Response
Nodes

created_at string 
Creation time of the node

name string
Name of the node

summary string
Regional summary of surrounding edges

uuid string
UUID of the node

attributes map from strings to any Optional
Additional attributes of the node. Dependent on node labels

labels list of strings Optional 
Labels associated with the node

Errors

400 Node Get by User ID Request Bad Request Error

500 Node Get by User ID Request Internal Server Error

Get Node Next


Built with


SDK Reference Graph Node

Get Group Nodes
Returns all nodes for a group.

GET /api/v2/graph/node/group/ :group_id Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.node.get_by_group_id( 
7 group_id="group_id",
8 )

200 Retrieved

1 [
2 {
3 "created_at": "created_at", 
4 "name": "name",
5 "summary": "summary", 
6 "uuid": "uuid",
7 "attributes": {
8 "key": "value"
9 },
10 "labels": [
11 "labels"
12 ]
13 } 
14 ]

Path parameters

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

group_id string Required 
Group ID

Response
Nodes

created_at string 
Creation time of the node

name string
Name of the node

summary string
Regional summary of surrounding edges

uuid string
UUID of the node

attributes map from strings to any Optional
Additional attributes of the node. Dependent on node labels

labels list of strings Optional 
Labels associated with the node

Errors

400 Node Get by Group ID Request Bad Request Error

500 Node Get by Group ID Request Internal Server Error

Get User Nodes Next


Built with


SDK Reference Graph Episode

Return any nodes and edges 
mentioned in an episode
Returns nodes and edges mentioned in an episode

GET /api/v2/graph/episodes/ :uuid /mentions Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.episode.get_nodes_and_edges( 
7 uuid_="uuid",
8 )

200 Retrieved

1 {
2 "edges": [
3 {
4 "created_at": "created_at", 
5 "fact": "fact",
6 "name": "name",
7 "source_node_uuid": "source_node_uuid", 
8 "target_node_uuid": "target_node_uuid", 
9 "uuid": "uuid",
10 "episodes": [
11 "episodes"
12 ],
13 "expired_at": "expired_at", 
14 "invalid_at": "invalid_at", 
15 "valid_at": "valid_at"
16 }
17 ],
18 "nodes": [ 
19 {

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

20 "created_at": "created_at", 
21 "name": "name",
22 "summary": "summary",
23 "uuid": "uuid",
24 "attributes": {
25 "key": "value"
26 },
27 "labels": [
28 "labels"

Path parameters

uuid string Required 
Episode uuid

Response
Graph search results

edges list of objects Optional

Show 10 properties

nodes list of objects Optional

Show 6 properties

Errors

400 Episode Get Nodes and Edges Request Bad Request Error

500 Episode Get Nodes and Edges Request Internal Server Error

Get Group Nodes Next


Built with


SDK Reference Graph Episode

Delete Episode
Deletes an episode by its UUID.

DELETE /api/v2/graph/episodes/ :uuid Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.episode.delete( 
7 uuid_="uuid",
8 )

200 Deleted

1 {
2 "message": "message" 
3 }

Path parameters

uuid string Required 
Episode UUID

Response
Episode deleted

message string Optional

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Errors

400 Episode Delete Request Bad Request Error

404 Episode Delete Request Not Found Error

500 Episode Delete Request Internal Server Error

Return any nodes and edges mentioned in an epis… Next

Built with


SDK Reference Graph Episode

Get Episode
Returns episodes by UUID

GET /api/v2/graph/episodes/ :uuid Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.graph.episode.get(
7 uuid_="uuid",
8 )

200 Retrieved

1 {
2 "content": "content",
3 "created_at": "created_at",
4 "uuid": "uuid",
5 "name": "name",
6 "source": "text",
7 "source_description": "source_description" 
8 }

Path parameters

uuid string Required 
Episode UUID

Response

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Episode

content string

created_at string

uuid string

name string Optional

source enum Optional 
Allowed values:

source_description string Optional

Errors

400 Episode Get Request Bad Request Error

500 Episode Get Request Internal Server Error

Delete Episode Next

Built with


SDK Reference Graph Episode

Get User Episodes
Returns episodes by user id.

GET /api/v2/graph/episodes/user/ :user_id Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.episode.get_by_user_id( 
7 user_id="user_id",
8 )

200 Retrieved

1 {
2 "episodes": [
3 {
4 "content": "content",
5 "created_at": "created_at", 
6 "uuid": "uuid",
7 "name": "name",
8 "source": "text",
9 "source_description": "source_description" 
10 }
11 ] 
12 }

Path parameters

user_id string Required 
User ID

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Query parameters

lastn integer Optional
The number of most recent episodes entries to retrieve.

Response
Episodes

episodes list of objects Optional

Show 6 properties

Errors

400 Episode Get by User ID Request Bad Request Error

500 Episode Get by User ID Request Internal Server Error

Get Episode Next

Built with


SDK Reference Graph Episode

Get Group Episodes
Returns episodes by group id.

GET /api/v2/graph/episodes/group/ :group_id Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.episode.get_by_group_id( 
7 group_id="group_id",
8 )

200 Retrieved

1 {
2 "episodes": [
3 {
4 "content": "content",
5 "created_at": "created_at", 
6 "uuid": "uuid",
7 "name": "name",
8 "source": "text",
9 "source_description": "source_description" 
10 }
11 ] 
12 }

Path parameters

group_id string Required 
Group ID

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Query parameters

lastn integer Optional
The number of most recent episodes to retrieve.

Response
Episodes

episodes list of objects Optional

Show 6 properties

Errors

400 Episode Get by Group ID Request Bad Request Error

500 Episode Get by Group ID Request Internal Server Error

Get User Episodes Next

Built with


SDK Reference Graph Edge

Delete Edge
Deletes an edge by UUID.

DELETE /api/v2/graph/edge/ :uuid Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.graph.edge.delete(
7 uuid_="uuid",
8 )

200 Deleted

1 {
2 "message": "message" 
3 }

Path parameters

uuid string Required 
Edge UUID

Response
Edge deleted

message string Optional

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Errors

400 Edge Delete Request Bad Request Error

500 Edge Delete Request Internal Server Error

Get Group Episodes Next

Built with


SDK Reference Graph Edge

Get Edge
Returns a specific edge by its UUID.

GET /api/v2/graph/edge/ :uuid Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.graph.edge.get(
7 uuid_="uuid",
8 )

200 Retrieved

1 {
2 "created_at": "created_at",
3 "fact": "fact",
4 "name": "name",
5 "source_node_uuid": "source_node_uuid", 
6 "target_node_uuid": "target_node_uuid", 
7 "uuid": "uuid",
8 "episodes": [
9 "episodes"
10 ],
11 "expired_at": "expired_at", 
12 "invalid_at": "invalid_at", 
13 "valid_at": "valid_at"
14 }

Path parameters

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


uuid string Required 
Edge UUID

Response
Edge

created_at string 
Creation time of the edge

fact string
Fact representing the edge and nodes that it connects

name string
Name of the edge, relation name

source_node_uuid string 
UUID of the source node

target_node_uuid string 
UUID of the target node

uuid string
UUID of the edge

episodes list of strings Optional
List of episode ids that reference these entity edges

expired_at string Optional
Datetime of when the node was invalidated

invalid_at string Optional
Datetime of when the fact stopped being true

valid_at string Optional
Datetime of when the fact became true


Was this page helpful? Yes No

Previous

Errors

400 Edge Get Request Bad Request Error

404 Edge Get Request Not Found Error

500 Edge Get Request Internal Server Error

Delete Edge Next

Built with


SDK Reference Graph Edge

Get User Edges
Returns all edges for a user.

GET /api/v2/graph/edge/user/ :user_id Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.edge.get_by_user_id( 
7 user_id="user_id",
8 )

200 Retrieved

1 [
2 {
3 "created_at": "created_at", 
4 "fact": "fact",
5 "name": "name",
6 "source_node_uuid": "source_node_uuid", 
7 "target_node_uuid": "target_node_uuid", 
8 "uuid": "uuid",
9 "episodes": [
10 "episodes"
11 ],
12 "expired_at": "expired_at", 
13 "invalid_at": "invalid_at", 
14 "valid_at": "valid_at"
15 } 
16 ]

Path parameters

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


user_id string Required 
User ID

Response
Edges

created_at string 
Creation time of the edge

fact string
Fact representing the edge and nodes that it connects

name string
Name of the edge, relation name

source_node_uuid string 
UUID of the source node

target_node_uuid string 
UUID of the target node

uuid string
UUID of the edge

episodes list of strings Optional
List of episode ids that reference these entity edges

expired_at string Optional
Datetime of when the node was invalidated

invalid_at string Optional
Datetime of when the fact stopped being true

valid_at string Optional


Was this page helpful? Yes No

Previous

Datetime of when the fact became true

Errors

400 Edge Get by User ID Request Bad Request Error

500 Edge Get by User ID Request Internal Server Error

Get Edge Next

Built with


SDK Reference Graph Edge

Get Group Edges
Returns all edges for a group.

GET /api/v2/graph/edge/group/ :group_id Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.edge.get_by_group_id( 
7 group_id="group_id",
8 )

200 Retrieved

1 [
2 {
3 "created_at": "created_at", 
4 "fact": "fact",
5 "name": "name",
6 "source_node_uuid": "source_node_uuid", 
7 "target_node_uuid": "target_node_uuid", 
8 "uuid": "uuid",
9 "episodes": [
10 "episodes"
11 ],
12 "expired_at": "expired_at", 
13 "invalid_at": "invalid_at", 
14 "valid_at": "valid_at"
15 } 
16 ]

Path parameters

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


group_id string Required 
Group ID

Response
Edges

created_at string 
Creation time of the edge

fact string
Fact representing the edge and nodes that it connects

name string
Name of the edge, relation name

source_node_uuid string 
UUID of the source node

target_node_uuid string 
UUID of the target node

uuid string
UUID of the edge

episodes list of strings Optional
List of episode ids that reference these entity edges

expired_at string Optional
Datetime of when the node was invalidated

invalid_at string Optional
Datetime of when the fact stopped being true

valid_at string Optional


Was this page helpful? Yes No

Previous

Datetime of when the fact became true

Errors

400 Edge Get by Group ID Request Bad Request Error

500 Edge Get by Group ID Request Internal Server Error

Get User Edges Next

Built with


SDK Reference Graph

Search Graph
Perform a graph search query.

POST /api/v2/graph/search Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.graph.search(
7 query="query",
8 )

200 Successful

1 {
2 "edges": [
3 {
4 "created_at": "created_at", 
5 "fact": "fact",
6 "name": "name",
7 "source_node_uuid": "source_node_uuid", 
8 "target_node_uuid": "target_node_uuid", 
9 "uuid": "uuid",
10 "episodes": [
11 "episodes"
12 ],
13 "expired_at": "expired_at", 
14 "invalid_at": "invalid_at", 
15 "valid_at": "valid_at"
16 }
17 ],
18 "nodes": [ 
19 {
20 "created_at": "created_at", 
21 "name": "name",

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


22 "summary": "summary",
23 "uuid": "uuid",
24 "attributes": {
25 "key": "value"
26 },
27 "labels": [
28 "labels"

Request
This endpoint expects an object.

query string Required
The string to search for (required)

center_node_uuid string Optional
Node to rerank around for node distance reranking

group_id string Optional
one of user_id or group_id must be provided

limit integer Optional
The maximum number of facts to retrieve. Defaults to 10. Limited to 50.

min_score double Optional 
Deprecated

mmr_lambda double Optional
weighting for maximal marginal relevance

reranker enum Optional 
Defaults to RRF
Allowed values:

scope enum Optional
Defaults to Edges. Communities will be added in the future. 
Allowed values:


Was this page helpful? Yes No

Previous

search_filters object Optional 
Search filters to apply to the search

Show 1 properties

user_id string Optional
one of user_id or group_id must be provided

Response
Graph search results

edges list of objects Optional

Show 10 properties

nodes list of objects Optional

Show 6 properties

Errors

400 Graph Search Request Bad Request Error

500 Graph Search Request Internal Server Error

Get Group Edges Next

Built with


SDK Reference Graph

Add Fact Triple
Add a fact triple for a user or group

POST /api/v2/graph/add-fact-triple Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.graph.add_fact_triple( 
7 fact="fact",
8 fact_name="fact_name",
9 target_node_name="target_node_name", 
10 )

200 Successful

1 {
2 "edge": {
3 "created_at": "created_at", 
4 "fact": "fact",
5 "name": "name",
6 "source_node_uuid": "source_node_uuid", 
7 "target_node_uuid": "target_node_uuid", 
8 "uuid": "uuid",
9 "episodes": [
10 "episodes"
11 ],
12 "expired_at": "expired_at", 
13 "invalid_at": "invalid_at", 
14 "valid_at": "valid_at"
15 },
16 "source_node": {
17 "created_at": "created_at", 
18 "name": "name",
19 "summary": "summary",

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


20 "uuid": "uuid",
21 "attributes": {
22 "key": "value"
23 },
24 "labels": [
25 "labels"
26 ]

Request
This endpoint expects an object.

fact string Required <=50 characters
The fact relating the two nodes that this edge represents

fact_name string Required >=1 character <=50 characters
The name of the edge to add. Should be all caps using snake case (eg RELATES_TO)

target_node_name string Required <=50 characters 
The name of the target node to add

created_at string Optional
The timestamp of the message

expired_at string Optional
The time (if any) at which the edge expires

fact_uuid string Optional 
The uuid of the edge to add

group_id string Optional

invalid_at string Optional
The time (if any) at which the fact stops being true

source_node_name string Optional <=50 characters 
The name of the source node to add

source_node_summary string Optional <=500 characters


The summary of the source node to add

source_node_uuid string Optional 
The source node uuid

target_node_summary string Optional <=500 characters 
The summary of the target node to add

target_node_uuid string Optional 
The target node uuid

user_id string Optional

valid_at string Optional
The time at which the fact becomes true

Response
Resulting triple

edge object Optional

Show 10 properties

source_node object Optional

Show 6 properties

target_node object Optional

Show 6 properties

Errors

400 Graph Add Fact Triple Request Bad Request Error

500 Graph Add Fact Triple Request Internal Server Error


Was this page helpful? Yes No

Previous Search Graph Next

Built with


SDK Reference Graph

Add Data
Add data to the graph. Note: each subscription tier has different limits on the amount of 
data that can be added to the graph please refer to the pricing page for more information.

POST /api/v2/graph Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.graph.add()

202 Accepted

1 {
2 "content": "content",
3 "created_at": "created_at",
4 "uuid": "uuid",
5 "name": "name",
6 "source": "text",
7 "source_description": "source_description" 
8 }

Request
This endpoint expects an object.

data string Optional

group_id string Optional

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

type enum Optional 
Allowed values:

user_id string Optional

Response
Added episode

content string

created_at string

uuid string

name string Optional

source enum Optional 
Allowed values:

source_description string Optional

Errors

400 Graph Add Request Bad Request Error

500 Graph Add Request Internal Server Error

Add Fact Triple Next

Built with


SDK Reference Group

Update Group
Updates information about a group.

PATCH /api/v2/groups/ :groupId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.group.update(
7 group_id="groupId",
8 )

201 Created

1 {
2 "created_at": "created_at",
3 "description": "description", 
4 "external_id": "external_id", 
5 "fact_rating_instruction": {
6 "examples": {
7 "high": "high",
8 "low": "low",
9 "medium": "medium"
10 },
11 "instruction": "instruction" 
12 },
13 "group_id": "group_id", 
14 "id": 1,
15 "name": "name",
16 "project_uuid": "project_uuid", 
17 "uuid": "uuid"
18 }

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Path parameters

groupId string Required 
Group ID

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

description string Optional

fact_rating_instruction object Optional

Show 2 properties

name string Optional

Response
The added group

created_at string Optional

description string Optional

external_id string Optional 
Deprecated

fact_rating_instruction object Optional


Was this page helpful? Yes No

Previous

Show 2 properties

group_id string Optional

id integer Optional

name string Optional

project_uuid string Optional

uuid string Optional

Errors

400 Group Update Request Bad Request Error

404 Group Update Request Not Found Error

500 Group Update Request Internal Server Error

Add Data Next

Built with


SDK Reference Group

Delete Group
Deletes a group.

DELETE /api/v2/groups/ :groupId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.group.delete(
7 group_id="groupId",
8 )

200 Deleted

1 {
2 "message": "message" 
3 }

Path parameters

groupId string Required 
Group ID

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Response
Deleted

message string Optional

Errors

400 Group Delete Request Bad Request Error

404 Group Delete Request Not Found Error

500 Group Delete Request Internal Server Error

Update Group Next

Built with


SDK Reference Group

Get Group
Returns a group.

GET /api/v2/groups/ :groupId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.group.get_group(
7 group_id="groupId",
8 )

200 Retrieved

1 {
2 "created_at": "created_at",
3 "description": "description", 
4 "external_id": "external_id", 
5 "fact_rating_instruction": {
6 "examples": {
7 "high": "high",
8 "low": "low",
9 "medium": "medium"
10 },
11 "instruction": "instruction" 
12 },
13 "group_id": "group_id", 
14 "id": 1,
15 "name": "name",
16 "project_uuid": "project_uuid", 
17 "uuid": "uuid"
18 }

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Path parameters

groupId string Required
The group_id of the group to get.

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Response
The group that was retrieved.

created_at string Optional

description string Optional

external_id string Optional 
Deprecated

fact_rating_instruction object Optional

Show 2 properties

group_id string Optional

id integer Optional

name string Optional

project_uuid string Optional

uuid string Optional


Was this page helpful? Yes No

Previous

Errors

404 Get Groups Group ID Request Not Found Error

500 Get Groups Group ID Request Internal Server Error

Delete Group Next

Built with


SDK Reference Group

Get All Groups
Returns all groups.

GET /api/v2/groups-ordered Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY",
5 )
6 client.group.get_all_groups()

200 Retrieved

1 {
2 "groups": [
3 {
4 "created_at": "created_at",
5 "description": "description", 
6 "external_id": "external_id", 
7 "group_id": "group_id",
8 "id": 1,
9 "name": "name",
10 "project_uuid": "project_uuid", 
11 "uuid": "uuid"
12 }
13 ],
14 "row_count": 1, 
15 "total_count": 1 
16 }

Headers

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

Authorization string Required
Header authentication of the form Api-Key <token>

Query parameters

pageNumber integer Optional
Page number for pagination, starting from 1.

pageSize integer Optional
Number of groups to retrieve per page.

Response
Successfully retrieved list of groups.

groups list of objects Optional

Show 9 properties

row_count integer Optional

total_count integer Optional

Errors

400 Get Groups Ordered Request Bad Request Error

500 Get Groups Ordered Request Internal Server Error

Get Group Next


Built with


SDK Reference Group

Create Group
Creates a new group.

POST /api/v2/groups Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.group.add(
7 group_id="group_id",
8 )

201 Created

1 {
2 "created_at": "created_at",
3 "description": "description", 
4 "external_id": "external_id", 
5 "fact_rating_instruction": {
6 "examples": {
7 "high": "high",
8 "low": "low",
9 "medium": "medium"
10 },
11 "instruction": "instruction" 
12 },
13 "group_id": "group_id", 
14 "id": 1,
15 "name": "name",
16 "project_uuid": "project_uuid", 
17 "uuid": "uuid"
18 }

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

group_id string Required

description string Optional

fact_rating_instruction object Optional

Show 2 properties

name string Optional

Response
The added group

created_at string Optional

description string Optional

external_id string Optional 
Deprecated

fact_rating_instruction object Optional

Show 2 properties

group_id string Optional

id integer Optional


Was this page helpful? Yes No

Previous

name string Optional

project_uuid string Optional

uuid string Optional

Errors

400 Group Add Request Bad Request Error

500 Group Add Request Internal Server Error

Get All Groups Next

Built with


SDK Reference User

Get User Sessions
Returns all sessions for a user.

GET /api/v2/users/ :userId /sessions Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.get_sessions(
7 user_id="userId",
8 )

200 Retrieved

1 [
2 {
3 "classifications": { 
4 "key": "value"
5 },
6 "created_at": "created_at", 
7 "deleted_at": "deleted_at", 
8 "ended_at": "ended_at",
9 "fact_rating_instruction": {
10 "instruction": "instruction" 
11 },
12 "facts": [
13 "facts"
14 ],
15 "id": 1,
16 "metadata": {
17 "key": "value"
18 },
19 "project_uuid": "project_uuid", 
20 "session_id": "session_id",
21 "updated_at": "updated_at",

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


22 "user_id": "user_id", 
23 "uuid": "uuid"
24 } 
25 ]

Path parameters

userId string Required 
User ID

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Response
OK

classifications map from strings to strings Optional

created_at string Optional

deleted_at string Optional

ended_at string Optional

fact_rating_instruction object Optional 
Deprecated

Show 2 properties

facts list of strings Optional 
Deprecated


Was this page helpful? Yes No

Previous

id integer Optional

metadata map from strings to any Optional 
Deprecated

project_uuid string Optional

session_id string Optional

updated_at string Optional 
Deprecated

user_id string Optional

uuid string Optional

Errors

500 User Get Sessions Request Internal Server Error

Create Group Next

Built with


SDK Reference User

Update User
Updates a user.

PATCH /api/v2/users/ :userId Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.update(
7 user_id="userId",
8 )

200 Updated

1 {
2 "created_at": "created_at", 
3 "deleted_at": "deleted_at", 
4 "email": "email",
5 "fact_rating_instruction": { 
6 "examples": {
7 "high": "high",
8 "low": "low",
9 "medium": "medium"
10 },
11 "instruction": "instruction" 
12 },
13 "first_name": "first_name", 
14 "id": 1,
15 "last_name": "last_name", 
16 "metadata": {
17 "key": "value"
18 },
19 "project_uuid": "project_uuid", 
20 "session_count": 1,
21 "updated_at": "updated_at",

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


22 "user_id": "user_id", 
23 "uuid": "uuid"
24 }

Path parameters

userId string Required 
User ID

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Request
This endpoint expects an object.

email string Optional
The email address of the user.

fact_rating_instruction object Optional 
Optional instruction to use for fact rating.

Show 2 properties

first_name string Optional 
The first name of the user.

last_name string Optional 
The last name of the user.

metadata map from strings to any Optional 
The metadata to update


Response
The user that was updated.

created_at string Optional

deleted_at string Optional

email string Optional

fact_rating_instruction object Optional

Show 2 properties

first_name string Optional

id integer Optional

last_name string Optional

metadata map from strings to any Optional 
Deprecated

project_uuid string Optional

session_count integer Optional 
Deprecated

updated_at string Optional 
Deprecated

user_id string Optional

uuid string Optional

Errors


Was this page helpful? Yes No

Previous

400 User Update Request Bad Request Error

404 User Update Request Not Found Error

500 User Update Request Internal Server Error

Get User Node Next

Built with


SDK Reference User

Get User Node
Returns a user’s node.

GET /api/v2/users/ :userId /node Python

1 from zep_cloud.client import Zep
2
3 client = Zep(
4 api_key="YOUR_API_KEY", 
5 )
6 client.user.get_node(
7 user_id="userId",
8 )

200 Retrieved

1 {
2 "node": {
3 "created_at": "created_at", 
4 "name": "name",
5 "summary": "summary", 
6 "uuid": "uuid",
7 "attributes": {
8 "key": "value"
9 },
10 "labels": [
11 "labels"
12 ]
13 } 
14 }

Path parameters

🚀 Zep Is The New State of the Art In Agent Memory - Learn More 🚀

Search /


Was this page helpful? Yes No

Previous

userId string Required
The user_id of the user to get the node for.

Headers

Authorization string Required
Header authentication of the form Api-Key <token>

Response
Response object containing the User node.

node object Optional

Show 6 properties

Errors

404 User Get Node Request Not Found Error

500 User Get Node Request Internal Server Error

Get User Sessions Next

Built with
