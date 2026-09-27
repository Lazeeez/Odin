from odin.eval.goldpatch import Insertion, parse_patch
from odin.eval.ground_truth import locate
from odin.parsing.python_symbols import extract_symbols

BASE = b"""import os


class Box:
    limit = 3

    def put(self, x):
        self.items.append(x)
        return x

    def take(self):
        return self.items.pop()
"""

PATCH = """diff --git a/pkg/box.py b/pkg/box.py
--- a/pkg/box.py
+++ b/pkg/box.py
@@ -1,4 +1,5 @@
 import os
+import sys


 class Box:
@@ -6,7 +7,12 @@ class Box:

     def put(self, x):
-        self.items.append(x)
+        if len(self.items) < self.limit:
+            self.items.append(x)
         return x

+    def peek(self):
+        # new helper
+        return self.items[-1]
+
     def take(self):
         return self.items.pop()
"""

NEW_FILE = """diff --git a/pkg/new.py b/pkg/new.py
new file mode 100644
--- /dev/null
+++ b/pkg/new.py
@@ -0,0 +1,2 @@
+def f():
+    pass
"""


def test_parse_modified_file():
    (edit,) = parse_patch(PATCH)
    assert edit.path == "pkg/box.py"
    assert edit.status == "modified"
    assert edit.removed_lines == {8}
    assert Insertion(1, 2, 0) in edit.insertions
    assert Insertion(8, 9, 8) in edit.insertions
    assert Insertion(10, 11, 4) in edit.insertions


def test_added_file():
    (edit,) = parse_patch(NEW_FILE)
    assert edit.status == "added"
    assert edit.path == "pkg/new.py"


def test_locate_maps_edits_to_owners():
    (edit,) = parse_patch(PATCH)
    owners, module_level = locate(edit, extract_symbols(BASE, "pkg/box.py"))
    assert {o.qualname for o in owners} == {"Box.put", "Box"}
    assert module_level


def test_appending_to_function_end_stays_in_function():
    base = b"def f():\n    a = 1\n\n\ndef g():\n    pass\n"
    patch = """--- a/m.py
+++ b/m.py
@@ -1,5 +1,6 @@
 def f():
     a = 1
+    return a


 def g():
"""
    (edit,) = parse_patch(patch)
    owners, module_level = locate(edit, extract_symbols(base, "m.py"))
    assert {o.qualname for o in owners} == {"f"}
    assert not module_level
