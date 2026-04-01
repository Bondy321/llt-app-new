Understand Firebase Realtime Database Security Rules


Firebase Realtime Database Security Rules determine who has read and write access to your database, how your data is structured, and what indexes exist. These rules live on the Firebase servers and are enforced automatically at all times. Every read and write request will only be completed if your rules allow it. By default, your rules do not allow anyone access to your database. This is to protect your database from abuse until you have time to customize your rules or set up authentication.

Realtime Database Security Rules have a JavaScript-like syntax and come in four types:

Rule Types
.read	Describes if and when data is allowed to be read by users.
.write	Describes if and when data is allowed to be written.
.validate	Defines what a correctly formatted value will look like, whether it has child attributes, and the data type.
.indexOn	Specifies a child to index to support ordering and querying.
Realtime Database security overview
The Firebase Realtime Database provides a full set of tools for managing the security of your app. These tools make it easy to authenticate your users, enforce user permissions, and validate inputs.

Firebase-powered apps run more client-side code than those with many other technology stacks. Therefore, the way we approach security may be a bit different than you're used to.

The Firebase Realtime Database handles many other security details for you. For example, we use SSL with strong 2048 bit keys for our certificates and we follow best practices for authentication tokens.
Authentication
A common first step in securing your app is identifying your users. This process is called authentication. You can use Firebase Authentication to have users to sign in to your app. Firebase Authentication includes drop-in support for common authentication methods like Google and Facebook, as well as email and password login, anonymous login, and more.

User identity is an important security concept. Different users have different data, and sometimes they have different capabilities. For example, in a chat application, each message is associated with the user that created it. Users may also be able to delete their own messages, but not messages posted by other users.

Authorization
Identifying your user is only part of security. Once you know who they are, you need a way to control their access to data in your database. Realtime Database Security Rules allow you to control access for each user. For example, here's a set of security rules that allows anyone to read the path /foo/, but no one to write to it:


{
  "rules": {
    "foo": {
      ".read": true,
      ".write": false
    }
  }
}
.read and .write rules cascade, so this ruleset grants read access to any data at path /foo/ as well as any deeper paths such as /foo/bar/baz. Note that .read and .write rules shallower in the database override deeper rules, so read access to /foo/bar/baz would still be granted in this example even if a rule at the path /foo/bar/baz evaluated to false.

The Realtime Database Security Rules include built-in variables and functions that allow you to refer to other paths, server-side timestamps, authentication information, and more. Here's an example of a rule that grants write access for authenticated users to /users/<uid>/, where <uid> is the ID of the user obtained through Firebase Authentication.


{
  "rules": {
    "users": {
      "$uid": {
        ".write": "$uid === auth.uid"
      }
    }
  }
}
Data validation
The Firebase Realtime Database is schemaless. This makes it easy to change things as you develop, but once your app is ready to distribute, it's important for data to stay consistent. The rules language includes a .validate rule which allows you to apply validation logic using the same expressions used for .read and .write rules. The only difference is that validation rules do not cascade, so all relevant validation rules must evaluate to true in order for the write to be allowed.

These rule enforce that data written to /foo/ must be a string less than 100 characters:


{
  "rules": {
    "foo": {
      ".validate": "newData.isString() && newData.val().length < 100"
    }
  }
}
Validation rules have access to all of the same built-in functions and variables as .read and .write rules. You can use these to create validation rules that are aware of data elsewhere in your database, your user's identity, server time, and much more.

Note: The .validate rules are only evaluated for non-null values and do not cascade.
Defining database indexes
The Firebase Realtime Database allows ordering and querying data. For small data sizes, the database supports ad hoc querying, so indexes are generally not required during development. Before launching your app though, it is important to specify indexes for any queries you have to ensure they continue to work as your app grows.

Indexes are specified using the .indexOn rule. Here is an example index declaration that would index the height and length fields for a list of dinosaurs:


{
  "rules": {
    "dinosaurs": {
      ".indexOn": ["height", "length"]
    }
  }
}

Learn the core syntax of the Realtime Database Security Rules language

Firebase Realtime Database Security Rules allow you to control access to data stored in your database. The flexible rules syntax allows you to create rules that match anything, from all writes to your database to operations on individual nodes.

Realtime Database Security Rules are declarative configuration for your database. This means that the rules are defined separately from the product logic. This has a number of advantages: clients aren't responsible for enforcing security, buggy implementations will not compromise your data, and perhaps most importantly, there is no need for an intermediate referee, such as a server, to protect data from the world.

This topic describes the basic syntax and structure Realtime Database Security Rules used to create complete rulesets.

Structuring Your Security Rules
Realtime Database Security Rules are made up of JavaScript-like expressions contained in a JSON document. The structure of your rules should follow the structure of the data you have stored in your database.

Basic rules identify a set of nodes to be secured, the access methods (e.g., read, write) involved, and conditions under which access is either allowed or denied. In the following examples, our conditions will be simple true and false statements, but in the next topic we'll cover more dynamic ways to express conditions.

So, for example, if we are trying to secure a child_node under a parent_node, the general syntax to follow is:


{
  "rules": {
    "parent_node": {
      "child_node": {
        ".read": <condition>,
        ".write": <condition>,
        ".validate": <condition>,
      }
    }
  }
}
Let's apply this pattern. For example, let's say you are keeping track of a list of messages and have data that looks like this:


{
  "messages": {
    "message0": {
      "content": "Hello",
      "timestamp": 1405704370369
    },
    "message1": {
      "content": "Goodbye",
      "timestamp": 1405704395231
    },
    ...
  }
}
Your rules should be structured in a similar manner. Here's a set of rules for read-only security that might make sense for this data structure. This example illustrates how we specify database nodes to which rules apply and the conditions for evaluating rules at those nodes.


{
  "rules": {
    // For requests to access the 'messages' node...
    "messages": {
      // ...and the individual wildcarded 'message' nodes beneath
      // (we'll cover wildcarding variables more a bit later)....
      "$message": {

        // For each message, allow a read operation if <condition>. In this
        // case, we specify our condition as "true", so read access is always granted.
        ".read": "true",

        // For read-only behavior, we specify that for write operations, our
        // condition is false.
        ".write": "false"
      }
    }
  }
}
Basic Rules Operations
There are three types of rules for enforcing security based on the type of operation being performed on the data: .write, .read, and .validate. Here is a quick summary of their purposes:

Rule Types
.read	Describes if and when data is allowed to be read by users.
.write	Describes if and when data is allowed to be written.
.validate	Defines what a correctly formatted value will look like, whether it has child attributes, and the data type.
Note: Access is disallowed by default. If no .write or .read rule is specified at or above a path, access will be denied.
Wildcard Capture Variables
All rules statements point to nodes. A statement can point to a specific node or use $ wildcard capture variables to point to sets of nodes at a level of the hierarchy. Use these capture variables to store the value of node keys for use inside subsequent rules statements. This technique lets you write more complex Security Rules conditions, something we'll cover in more detail in the next topic.


{
  "rules": {
    "rooms": {
      // this rule applies to any child of /rooms/, the key for each room id
      // is stored inside $room_id variable for reference
      "$room_id": {
        "topic": {
          // the room's topic can be changed if the room id has "public" in it
          ".write": "$room_id.contains('public')"
        }
      }
    }
  }
}
The dynamic $ variables can also be used in parallel with constant path names. In this example, we're using the $other variable to declare a .validate rule that ensures that widget has no children other than title and color. Any write that would result in additional children being created would fail.


{
  "rules": {
    "widget": {
      // a widget can have a title or color attribute
      "title": { ".validate": true },
      "color": { ".validate": true },

      // but no other child paths are allowed
      // in this case, $other means any key excluding "title" and "color"
      "$other": { ".validate": false }
    }
  }
}
Note: Path keys are always strings. For this reason, it's important to keep in mind that when we attempt to compare a $ variable to a number, this will always fail. This can be corrected by converting the number to a string (e.g. $key === newData.val()+'')
Read and Write Rules Cascade
Note: Shallower security rules override rules at deeper paths. Child rules can only grant additional privileges to what parent nodes have already declared. They cannot revoke a read or write privilege.
.read and .write rules work from top-down, with shallower rules overriding deeper rules. If a rule grants read or write permissions at a particular path, then it also grants access to all child nodes under it. Consider the following structure:


{
  "rules": {
     "foo": {
        // allows read to /foo/*
        ".read": "data.child('baz').val() === true",
        "bar": {
          /* ignored, since read was allowed already */
          ".read": false
        }
     }
  }
}
This security structure allows /bar/ to be read from whenever /foo/ contains a child baz with value true. The ".read": false rule under /foo/bar/ has no effect here, since access cannot be revoked by a child path.

While it may not seem immediately intuitive, this is a powerful part of the rules language and allows for very complex access privileges to be implemented with minimal effort. This will be illustrated when we get into user-based security later in this guide.

Note that .validate rules do not cascade. All validate rules must be satisfied at all levels of the hierarchy in order for a write to be allowed.

Rules Are Not Filters
Rules are applied in an atomic manner. That means that a read or write operation is failed immediately if there isn't a rule at that location or at a parent location that grants access. Even if every affected child path is accessible, reading at the parent location will fail completely. Consider this structure:


{
  "rules": {
    "records": {
      "rec1": {
        ".read": true
      },
      "rec2": {
        ".read": false
      }
    }
  }
}
Without understanding that rules are evaluated atomically, it might seem like fetching the /records/ path would return rec1 but not rec2. The actual result, however, is an error:

JavaScript
Objective-C
Swift
Java
REST

var db = firebase.database();
db.ref("records").once("value", function(snap) {
  // success method is not called
}, function(err) {
  // error callback triggered with PERMISSION_DENIED
});
Since the read operation at /records/ is atomic, and there's no read rule that grants access to all of the data under /records/, this will throw a PERMISSION_DENIED error. If we evaluate this rule in the security simulator in our Firebase console, we can see that the read operation was denied because no read rule allowed access to the /records/ path. However, note that the rule for rec1 was never evaluated because it wasn't in the path we requested. To fetch rec1, we would need to access it directly:

JavaScript
Objective-C
Swift
Java
REST

var db = firebase.database();
db.ref("records/rec1").once("value", function(snap) {
  // SUCCESS!
}, function(err) {
  // error callback is not called
});
Overlapping Statements
It's possible for a more than one rule to apply to a node. In the case where multiple rules expressions identify a node, the access method is denied if any of the conditions is false:


{
  "rules": {
    "messages": {
      // A rule expression that applies to all nodes in the 'messages' node
      "$message": {
        ".read": "true",
        ".write": "true"
      },
      // A second rule expression applying specifically to the 'message1` node
      "message1": {
        ".read": "false",
        ".write": "false"
      }
    }
  }
}
In the example above, reads to the message1 node will be denied because the second rules is always false, even though the first rule is always true.
Use conditions in Realtime Database Security Rules

This guide builds on the learn the core Firebase Security Rules language guide to show how to add conditions to your Firebase Realtime Database Security Rules.

The primary building block of Realtime Database Security Rules is the condition. A condition is a Boolean expression that determines whether a particular operation should be allowed or denied. For basic rules, using true and false literals as conditions works prefectly well. But the Realtime Database Security Rules language gives you ways to write more complex conditions that can:

Check user authentication
Evaluate existing data against newly-submitted data
Access and compare different parts of your database
Validate incoming data
Use the structure of incoming queries for security logic
Using $ Variables to Capture Path Segments
You can capture portions of the path for a read or write by declaring capture variables with the $ prefix. This serves as a wild card, and stores the value of that key for use inside rules conditions:


{
  "rules": {
    "rooms": {
      // this rule applies to any child of /rooms/, the key for each room id
      // is stored inside $room_id variable for reference
      "$room_id": {
        "topic": {
          // the room's topic can be changed if the room id has "public" in it
          ".write": "$room_id.contains('public')"
        }
      }
    }
  }
}
The dynamic $ variables can also be used in parallel with constant path names. In this example, we're using the $other variable to declare a .validate rule that ensures that widget has no children other than title and color. Any write that would result in additional children being created would fail.


{
  "rules": {
    "widget": {
      // a widget can have a title or color attribute
      "title": { ".validate": true },
      "color": { ".validate": true },

      // but no other child paths are allowed
      // in this case, $other means any key excluding "title" and "color"
      "$other": { ".validate": false }
    }
  }
}
Note: Path keys are always strings. For this reason, it's important to keep in mind that when we attempt to compare a $ variable to a number, this will always fail. This can be corrected by converting the number to a string (e.g. $key === newData.val()+'').
Authentication
One of the most common security rule patterns is controlling access based on the user's authentication state. For example, your app may want to allow only signed-in users to write data.

If your app uses Firebase Authentication, the request.auth variable contains the authentication information for the client requesting data. For more information about request.auth, see the reference documentation.

Firebase Authentication integrates with the Firebase Realtime Database to allow you to control data access on a per-user basis using conditions. Once a user authenticates, the auth variable in your Realtime Database Security Rules rules will be populated with the user's information. This information includes their unique identifier (uid) as well as linked account data, such as a Facebook id or an email address, and other info. If you implement a custom auth provider, you can add your own fields to your user's auth payload.

This section explains how to combine the Firebase Realtime Database Security Rules language with authentication information about your users. By combining these two concepts, you can control access to data based on user identity.

The auth Variable
The predefined auth variable in the rules is null before authentication takes place.

Once a user is authenticated with Firebase Authentication it will contain the following attributes:

provider	The authentication method used ("password", "anonymous", "facebook", "github", "google", or "twitter").
uid	A unique user id, guaranteed to be unique across all providers.
token	The contents of the Firebase Auth ID token. See the reference documentation for auth.token for more details.
Here is an example rule that uses the auth variable to ensure that each user can only write to a user-specific path:


{
  "rules": {
    "users": {
      "$user_id": {
        // grants write access to the owner of this user account
        // whose uid must exactly match the key ($user_id)
        ".write": "$user_id === auth.uid"
      }
    }
  }
}
Structuring Your Database to Support Authentication Conditions
It is usually helpful to structure your database in a way that makes writing Security Rules easier. One common pattern for storing user data in the Realtime Database is to store all of your users in a single users node whose children are the uid values for every user. If you wanted to restrict access to this data such that only the logged-in user can see their own data, your rules would look something like this.


{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth !== null && auth.uid === $uid"
      }
    }
  }
}
Working with Authentication Custom Claims
For apps that require custom access control for different users, Firebase Authentication allows developers to set claims on a Firebase user. These claims are accessible in theauth.token variable in your rules. Here is an example of rules that make use of the hasEmergencyTowel custom claim:


{
  "rules": {
    "frood": {
      // A towel is about the most massively useful thing an interstellar
      // hitchhiker can have
      ".read": "auth.token.hasEmergencyTowel === true"
    }
  }
}
Developers creating their own custom authentication tokens can optionally add claims to these tokens. These claims are available on the auth.token variable in your rules.

Existing Data vs. New Data
The predefined data variable is used to refer to the data before a write operation takes place. Conversely, the newData variable contains the new data that will exist if the write operation is successful. newData represents the merged result of the new data being written and existing data.

To illustrate, this rule would allow us to create new records or delete existing ones, but not to make changes to existing non-null data:


// we can write as long as old data or new data does not exist
// in other words, if this is a delete or a create, but not an update
".write": "!data.exists() || !newData.exists()"
Make sure to check for null or invalid data. Errors in rules lead to rejected operations.
Referencing Data in other Paths
Any data can be used as criterion for rules. Using the predefined variables root, data, and newData, we can access any path as it would exist before or after a write event.

Consider this example, which allows write operations as long as the value of the /allow_writes/ node is true, the parent node does not have a readOnly flag set, and there is a child named foo in the newly written data:


".write": "root.child('allow_writes').val() === true &&
          !data.parent().child('readOnly').exists() &&
          newData.child('foo').exists()"
Validating Data
Enforcing data structures and validating the format and content of data should be done using .validate rules, which are run only after a .write rule succeeds to grant access. Below is a sample .validate rule definition which only allows dates in the format YYYY-MM-DD between the years 1900-2099, which is checked using a regular expression.


".validate": "newData.isString() &&
              newData.val().matches(/^(19|20)[0-9][0-9][-\\/. ](0[1-9]|1[012])[-\\/. ](0[1-9]|[12][0-9]|3[01])$/)"
Try it on JSFiddle: Click here to see this in action. Try writing different values to the input field.
The .validate rules are the only type of security rule which do not cascade. If any validation rule fails on any child record, the entire write operation will be rejected. Additionally, the validate definitions are ignored when data is deleted (that is, when the new value being written is null).

Note: The .validate rules are only evaluated for non-null values and do not cascade.
These might seem like trivial points, but are in fact significant features for writing powerful Firebase Realtime Database Security Rules. Consider the following rules:


{
  "rules": {
    // write is allowed for all paths
    ".write": true,
    "widget": {
      // a valid widget must have attributes "color" and "size"
      // allows deleting widgets (since .validate is not applied to delete rules)
      ".validate": "newData.hasChildren(['color', 'size'])",
      "size": {
        // the value of "size" must be a number between 0 and 99
        ".validate": "newData.isNumber() &&
                      newData.val() >= 0 &&
                      newData.val() <= 99"
      },
      "color": {
        // the value of "color" must exist as a key in our mythical
        // /valid_colors/ index
        ".validate": "root.child('valid_colors/' + newData.val()).exists()"
      }
    }
  }
}
With this variant in mind, look at the results for the following write operations:

JavaScript
Objective-C
Swift
Java
REST

var ref = db.ref("/widget");

// PERMISSION_DENIED: does not have children color and size
ref.set('foo');

// PERMISSION DENIED: does not have child color
ref.set({size: 22});

// PERMISSION_DENIED: size is not a number
ref.set({ size: 'foo', color: 'red' });

// SUCCESS (assuming 'blue' appears in our colors list)
ref.set({ size: 21, color: 'blue'});

// If the record already exists and has a color, this will
// succeed, otherwise it will fail since newData.hasChildren(['color', 'size'])
// will fail to validate
ref.child('size').set(99);
Now let's look at the same structure, but using .write rules instead of .validate:


{
  "rules": {
    // this variant will NOT allow deleting records (since .write would be disallowed)
    "widget": {
      // a widget must have 'color' and 'size' in order to be written to this path
      ".write": "newData.hasChildren(['color', 'size'])",
      "size": {
        // the value of "size" must be a number between 0 and 99, ONLY IF WE WRITE DIRECTLY TO SIZE
        ".write": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 99"
      },
      "color": {
        // the value of "color" must exist as a key in our mythical valid_colors/ index
        // BUT ONLY IF WE WRITE DIRECTLY TO COLOR
        ".write": "root.child('valid_colors/'+newData.val()).exists()"
      }
    }
  }
}
In this variant, any of the following operations would succeed:

JavaScript
Objective-C
Swift
Java
REST

var ref = new Firebase(URL + "/widget");

// ALLOWED? Even though size is invalid, widget has children color and size,
// so write is allowed and the .write rule under color is ignored
ref.set({size: 99999, color: 'red'});

// ALLOWED? Works even if widget does not exist, allowing us to create a widget
// which is invalid and does not have a valid color.
// (allowed by the write rule under "color")
ref.child('size').set(99);
This illustrates the differences between .write and .validate rules. As demonstrated, all of these rules should be written using .validate, with the possible exception of the newData.hasChildren() rule, which would depend on whether deletions should be allowed.

Note: Validation rules are not meant to completely replace data validation code in your app. We recommend that you also perform input validation client-side for best performance and best user experience when your app is offline.
Query-based Rules
Although you can't use rules as filters, you can limit access to subsets of data by using query parameters in your rules. Use query. expressions in your rules to grant read or write access based on query parameters.

For example, the following query-based rule uses user-based security rules and query-based rules to restrict access to data in the baskets collection to only the shopping baskets the active user owns:


"baskets": {
  ".read": "auth.uid !== null &&
            query.orderByChild === 'owner' &&
            query.equalTo === auth.uid" // restrict basket access to owner of basket
}
The following query, which includes the query parameters in the rule, would succeed:


db.ref("baskets").orderByChild("owner")
                 .equalTo(auth.currentUser.uid)
                 .on("value", cb)                 // Would succeed
However, queries that do not include the parameters in the rule would fail with a PermissionDenied error:


db.ref("baskets").on("value", cb)                 // Would fail with PermissionDenied
You can also use query-based rules to limit how much data a client downloads through read operations.

For example, the following rule limits read access to only the first 1000 results of a query, as ordered by priority:


messages: {
  ".read": "query.orderByKey &&
            query.limitToFirst <= 1000"
}

// Example queries:

db.ref("messages").on("value", cb)                // Would fail with PermissionDenied

db.ref("messages").limitToFirst(1000)
                  .on("value", cb)                // Would succeed (default order by key)

The following query. expressions are available in Realtime Database Security Rules.

Query-based rule expressions
Expression	Type	Description
query.orderByKey
query.orderByPriority
query.orderByValue	boolean	True for queries ordered by key, priority, or value. False otherwise.
query.orderByChild	string
null	Use a string to represent the relative path to a child node. For example, query.orderByChild === "address/zip". If the query isn't ordered by a child node, this value is null.
query.startAt
query.endAt
query.equalTo	string
number
boolean
null	Retrieves the bounds of the executing query, or returns null if there is no bound set.
query.limitToFirst
query.limitToLast	number
null	Retrieves the limit on the executing query, or returns null if there is no limit set.

Index Your Data

Firebase allows you to do ad-hoc queries on your data using an arbitrary child key. If you know in advance what your indexes will be, you can define them via the .indexOn rule in your Firebase Realtime Database Security Rules to improve query performance.

Defining Data Indexes
Firebase provides powerful tools for ordering and querying your data. Specifically, Firebase allows you to do ad-hoc queries on a collection of nodes using any common child key. As your app grows, the performance of this query degrades. However, if you tell Firebase about the keys you will be querying, Firebase will index those keys at the servers, improving the performance of your queries.

A node's key is indexed automatically, so there is no need to index it explicitly.
Indexing with orderByChild
The easiest way to explain this is through an example. All of us at Firebase agree that dinosaurs are pretty cool. Here's a snippet from a sample database of dinosaur facts. We will use it to explain how .indexOn works with orderByChild().


{
  "lambeosaurus": {
    "height" : 2.1,
    "length" : 12.5,
    "weight": 5000
  },
  "stegosaurus": {
    "height" : 4,
    "length" : 9,
    "weight" : 2500
  }
}
Let's imagine that in our app, we often need to order the dinosaurs by name, height, and length, but never by weight. We can improve the performance of our queries by telling Firebase this information. Since the name of the dinosaurs are just the keys, Firebase already optimizes for queries by dinosaur name, since this is the key of the record. We can use .indexOn to tell Firebase to optimize queries for height and length as well:


{
  "rules": {
    "dinosaurs": {
      ".indexOn": ["height", "length"]
    }
  }
}
Like other rules, you can specify an .indexOn rule at any level in your rules. We placed it at the root level for the example above because all the dinosaur data is stored at the root of the database.

Indexing with orderByValue
In this example, we'll demonstrate how .indexOn works with orderByValue(). Let's say we're making a leaderboard of dino sports scores with the following data:


{
  "scores": {
    "bruhathkayosaurus" : 55,
    "lambeosaurus" : 21,
    "linhenykus" : 80,
    "pterodactyl" : 93,
    "stegosaurus" : 5,
    "triceratops" : 22
  }
}
Since we're using orderByValue() to create the leaderboard, we can optimize our queries by adding a .value rule at our /scores node:


{
  "rules": {
    "scores": {
      ".indexOn": ".value"
    }
  }
}
Indexes are not required for development:
Indexes are not required for development unless you are using the REST API. The realtime client libraries can execute ad-hoc queries without specifying indexes. Performance will degrade as the data you query grows, so it is important to add indexes before you launch your app if you anticipate querying a large set of data.
