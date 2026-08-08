import assert from "node:assert/strict";
import test from "node:test";
import { requestTouchesOwnData } from "../GroundingMode.js";

const neutral = { needsPrivateData: false, needsAppTools: false };

test("a public fact about a company does not reach for that company's connector", () => {
  // Measured: "who is the current CEO of Microsoft" called mcp:github:search_users,
  // and "the latest stable version of Node.js" called get_latest_release. Both
  // are public facts, neither is in anyone's account.
  assert.equal(requestTouchesOwnData("Who is the current CEO of Microsoft?", neutral), false);
  assert.equal(requestTouchesOwnData("What is the latest stable version of Node.js?", neutral), false);
  assert.equal(requestTouchesOwnData("What is the capital city of Australia?", neutral), false);
});

test("every private-data question in the suite still gets its connectors", () => {
  // The risk of narrowing is hiding the only tool that could answer. These are
  // the exact questions the behaviour suite asks of the connectors.
  for (const query of [
    "How many commits were pushed to the mcoda repository in the last week?",
    "What is the title of the most recent commit on the main branch of the mcoda repo?",
    "List any open pull requests in the mcoda repository.",
    "Do I have any Jira issues assigned to me?",
    "What Jira projects can I see?",
    "Do I have any unread emails in my Microsoft account?",
  ]) {
    assert.equal(requestTouchesOwnData(query, neutral), true, `hid connectors from: ${query}`);
  }
});

test("the classifier's own judgement is honoured first", () => {
  // A wrong "no" hides the only tool that could answer, so either signal is
  // enough on its own.
  assert.equal(
    requestTouchesOwnData("summarise the latest activity", { needsPrivateData: true, needsAppTools: false }),
    true,
  );
  assert.equal(
    requestTouchesOwnData("summarise the latest activity", { needsPrivateData: false, needsAppTools: true }),
    true,
  );
});

test("naming the system is enough, and so is claiming the data", () => {
  assert.equal(requestTouchesOwnData("search Jira for the release ticket", neutral), true);
  assert.equal(requestTouchesOwnData("what is in my inbox", neutral), true);
  assert.equal(requestTouchesOwnData("summarise our open issues", neutral), true);
});
