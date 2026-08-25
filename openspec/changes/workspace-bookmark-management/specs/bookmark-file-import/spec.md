# Bookmark File Import Specification

## Purpose

Let an admin bulk-populate a workspace's bookmark tree from an uploaded Netscape bookmarks.html
export, parsed entirely client-side, materialized through the existing create endpoints with a
hard size ceiling and explicit partial-failure recovery — no new backend surface.

## Requirements

### Requirement: Client-Side Netscape Bookmarks Parsing

The system MUST parse an uploaded `bookmarks.html` file using `DOMParser` entirely in the
browser. The file's contents MUST NOT be transmitted to any endpoint except as the ordinary
per-item create calls that result from a confirmed import.

#### Scenario: Valid Netscape export parses into a matching node tree

- GIVEN a well-formed Netscape `bookmarks.html` export with nested folders and bookmarks
- WHEN the admin uploads it
- THEN it is parsed client-side into a node tree whose folder/bookmark nesting matches the
  source file, before any network create call is issued

#### Scenario: Malformed file is rejected before any create call

- GIVEN a file that is not a valid Netscape bookmarks export
- WHEN the admin uploads it
- THEN a clear parse error is shown and zero create calls are issued

### Requirement: Import Size Ceiling

The system MUST count the total node count of a parsed import before creating anything. Imports
exceeding 500 nodes MUST be refused up front, with a message naming the bulk import endpoint as
the appropriate fix for that scale, and MUST issue zero create calls.

#### Scenario: Import at exactly 500 nodes proceeds

- GIVEN a parsed import totaling exactly 500 nodes
- WHEN the admin confirms the import
- THEN the import proceeds and creates nodes sequentially

#### Scenario: Import over 500 nodes is refused up front

- GIVEN a parsed import totaling 501 or more nodes
- WHEN the admin attempts to confirm the import
- THEN the import is refused before any create call, with a message naming the bulk endpoint as
  the fix for imports at that scale

### Requirement: Sequential Parent-Before-Child Creation

The system MUST create nodes sequentially, one create call at a time, always creating a folder
before any of its children so that each child's `CreateBookmark`/`CreateFolder` call can
reference its parent's server-assigned id. No concurrent create calls MUST be issued. Each
create call MUST include a deliberate `X-Sync-Event-Id`.

#### Scenario: Parents are created before their children

- GIVEN a parsed tree with a folder containing bookmarks and a nested subfolder
- WHEN the import runs
- THEN the folder is created and its server-assigned id is used for every direct child's
  `parentId` before any of those children are created

#### Scenario: Final tree structure matches the source file

- GIVEN a successful import with no failures
- WHEN the import completes
- THEN the workspace's tree, refetched from the server, matches the source file's folder/bookmark
  nesting exactly

### Requirement: Visible Per-Item Import Progress

The system MUST show visible progress as items are created during an import (for example, a
completed-count against the total).

#### Scenario: Progress advances as each item resolves

- GIVEN an import of N nodes is running
- WHEN each sequential create call resolves
- THEN the visible progress indicator advances to reflect the count of items completed so far

### Requirement: Partial-Failure List and Retry

A mid-import failure MUST NOT roll back or silently truncate the import: every already-created
node stays in place. The system MUST show an explicit list of failed items, each with its
failure reason, and MUST offer a "retry failed items" action that re-attempts only the failed
set. A node whose parent failed to create MUST be recorded in the failed list with a reason
identifying the missing parent, and MUST NOT be attempted until its parent exists.

#### Scenario: Mid-import failure preserves prior successes and lists the failure

- GIVEN an import where node K fails to create (e.g. a network or validation error)
- WHEN the failure occurs
- THEN nodes created before K remain in the workspace, node K appears in a failed-items list with
  its reason, and the import continues attempting subsequent independent nodes

#### Scenario: Children of a failed parent are listed as failed, not attempted

- GIVEN a folder fails to create during import
- WHEN the import reaches that folder's children
- THEN each child is added to the failed-items list with a reason identifying the missing parent,
  and no create call is attempted for them

#### Scenario: Retry re-attempts only the failed set

- GIVEN a completed import left a non-empty failed-items list
- WHEN the admin selects "retry failed items"
- THEN only the previously failed items are re-attempted, in the same parent-before-child order,
  and items that succeed are removed from the failed list

#### Scenario: Repeated retry failure keeps the item listed

- GIVEN a retried item fails again
- WHEN the retry attempt completes
- THEN the item remains in the failed-items list with its (possibly updated) failure reason,
  available for another retry
