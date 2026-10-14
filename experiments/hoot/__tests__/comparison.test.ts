import { test } from "node:test";
import { verify } from "../comparison/harness.ts";
import { cases } from "../comparison/reference.ts";
test("comparison harness accepts a known complete greeting in both frontends", async () => {
  await verify(
    "tisyn",
    `Let("r",Ask({"message":"Name?"}),If(Eq(Get(Ref("r"),"action"),"accept"),Construct({"status":"done","greeting":Concat("Hello, ",Get(Get(Ref("r"),"content"),"reply"),"!")}),Construct({"status":Get(Ref("r"),"action")})))`,
    cases[0],
  );
  await verify(
    "scheme",
    `(let ((r (effect "ask" (object (cons "message" "Name?"))))) (if (equal? (field r "action") "accept") (object (cons "status" "done") (cons "greeting" (string-append "Hello, " (field (field r "content") "reply") "!"))) (object (cons "status" (field r "action")))))`,
    cases[0],
  );
});
