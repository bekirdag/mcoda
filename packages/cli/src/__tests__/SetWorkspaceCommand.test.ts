import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectWorkspaceStacks,
  parseSetWorkspaceArgs,
  resolveNodeTestPackages,
  resolveJavaTestPackages,
  resolveDotnetTestPackages,
  resolveGoTestPackages,
  resolveFlutterTestPackages,
  resolveReactNativeTestPackages,
  resolveIosTestPackages,
  resolveAndroidTestPackages,
  resolvePhpTestPackages,
  resolvePythonTestPackages,
  resolveRubyTestPackages,
} from "../commands/workspace/SetWorkspaceCommand.js";

describe("set-workspace argument parsing", () => {
  it("defaults to git and docdex enabled", () => {
    const parsed = parseSetWorkspaceArgs([]);
    assert.equal(parsed.git, true);
    assert.equal(parsed.docdex, true);
  });

  it("parses workspace root and disables features", () => {
    const parsed = parseSetWorkspaceArgs(["--workspace-root", "/tmp/ws", "--no-git", "--no-docdex"]);
    assert.equal(parsed.workspaceRoot, "/tmp/ws");
    assert.equal(parsed.git, false);
    assert.equal(parsed.docdex, false);
  });

  it("parses codex sandbox override", () => {
    const parsed = parseSetWorkspaceArgs(["--codex-no-sandbox"]);
    assert.equal(parsed.codexNoSandbox, true);
    const parsedFalse = parseSetWorkspaceArgs(["--codex-no-sandbox=false"]);
    assert.equal(parsedFalse.codexNoSandbox, false);
  });
});

describe("set-workspace stack detection", () => {
  it("detects Java stack via pom.xml", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-java-"));
    try {
      await fs.writeFile(path.join(dir, "pom.xml"), "<project></project>");
      const stacks = await detectWorkspaceStacks(dir);
      assert.ok(stacks.includes("java"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Go stack via go.mod", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-go-"));
    try {
      await fs.writeFile(path.join(dir, "go.mod"), "module example.com/test");
      const stacks = await detectWorkspaceStacks(dir);
      assert.ok(stacks.includes("go"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects PHP and Ruby stacks via composer.json and Gemfile", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-php-ruby-"));
    try {
      await fs.writeFile(path.join(dir, "composer.json"), "{}");
      await fs.writeFile(path.join(dir, "Gemfile"), "source \"https://rubygems.org\"");
      const stacks = await detectWorkspaceStacks(dir);
      assert.ok(stacks.includes("php"));
      assert.ok(stacks.includes("ruby"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects Flutter and React Native via pubspec and package.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-mobile-"));
    try {
      await fs.writeFile(path.join(dir, "pubspec.yaml"), "flutter:\n  uses-material-design: true\n");
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "rn", dependencies: { "react-native": "0.0.0" } }),
      );
      const stacks = await detectWorkspaceStacks(dir);
      assert.ok(stacks.includes("flutter"));
      assert.ok(stacks.includes("react-native"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("detects iOS and Android via platform directories", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-platform-"));
    try {
      await fs.mkdir(path.join(dir, "ios"), { recursive: true });
      await fs.writeFile(path.join(dir, "ios", "Podfile"), "platform :ios");
      await fs.mkdir(path.join(dir, "android", "app"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "android", "app", "build.gradle"),
        "android { }",
      );
      const stacks = await detectWorkspaceStacks(dir);
      assert.ok(stacks.includes("ios"));
      assert.ok(stacks.includes("android"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("set-workspace node test package selection", () => {
  it("prefers vitest when Vite is detected", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-node-vite-"));
    try {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "vite-app", dependencies: { vite: "^5.0.0" } }),
      );
      const pkg = JSON.parse(
        await fs.readFile(path.join(dir, "package.json"), "utf8"),
      );
      const resolved = await resolveNodeTestPackages(dir, pkg);
      assert.ok(resolved.packages.includes("vitest"));
      assert.ok(!resolved.packages.includes("jest"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("adds testing-library and axios mock adapter when applicable", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-node-ui-"));
    try {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "ui-app",
          dependencies: { react: "^18.0.0", axios: "^1.0.0" },
        }),
      );
      await fs.writeFile(path.join(dir, "tsconfig.json"), "{}");
      const pkg = JSON.parse(
        await fs.readFile(path.join(dir, "package.json"), "utf8"),
      );
      const resolved = await resolveNodeTestPackages(dir, pkg);
      assert.ok(resolved.packages.includes("@testing-library/react"));
      assert.ok(resolved.packages.includes("axios-mock-adapter"));
      assert.ok(resolved.packages.includes("cypress"));
      assert.ok(resolved.packages.includes("puppeteer"));
      assert.ok(resolved.tsPackages.includes("@types/supertest"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("set-workspace python test package selection", () => {
  it("adds pytest-django when Django is detected in requirements", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-py-django-"));
    try {
      await fs.writeFile(
        path.join(dir, "requirements.txt"),
        "django\nrequests\n",
      );
      const resolved = await resolvePythonTestPackages(dir);
      assert.ok(resolved);
      assert.ok(resolved.packages.includes("pytest"));
      assert.ok(resolved.packages.includes("httpx"));
      assert.ok(resolved.packages.includes("pytest-httpx"));
      assert.ok(resolved.packages.includes("pytest-django"));
      assert.ok(!resolved.packages.includes("pytest-flask"));
      assert.ok(!resolved.missing.includes("requests"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("adds pytest-flask when Flask is detected in pyproject", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-py-flask-"));
    try {
      await fs.writeFile(
        path.join(dir, "pyproject.toml"),
        "[project]\ndependencies = [\"flask\"]\n",
      );
      const resolved = await resolvePythonTestPackages(dir);
      assert.ok(resolved);
      assert.ok(resolved.packages.includes("pytest-flask"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("set-workspace dotnet test package selection", () => {
  it("adds ASP.NET testing helpers for web projects", () => {
    const content =
      '<Project Sdk="Microsoft.NET.Sdk.Web">' +
      '<ItemGroup><PackageReference Include="xunit" Version="2.5.0" /></ItemGroup>' +
      "</Project>";
    const resolved = resolveDotnetTestPackages(content);
    assert.ok(resolved.packages.includes("NUnit"));
    assert.ok(resolved.packages.includes("MSTest.TestFramework"));
    assert.ok(resolved.packages.includes("Moq"));
    assert.ok(resolved.packages.includes("NSubstitute"));
    assert.ok(resolved.packages.includes("FakeItEasy"));
    assert.ok(resolved.packages.includes("WireMock.Net"));
    assert.ok(resolved.packages.includes("Selenium.WebDriver"));
    assert.ok(resolved.packages.includes("Microsoft.AspNetCore.Mvc.Testing"));
  });

  it("skips ASP.NET helpers for non-web projects", () => {
    const content =
      '<Project Sdk="Microsoft.NET.Sdk">' +
      '<ItemGroup><PackageReference Include="xunit" Version="2.5.0" /></ItemGroup>' +
      "</Project>";
    const resolved = resolveDotnetTestPackages(content);
    assert.ok(!resolved.packages.includes("Microsoft.AspNetCore.Mvc.Testing"));
  });
});

describe("set-workspace java test package selection", () => {
  it("injects missing Maven dependencies", () => {
    const pom = [
      "<project>",
      "  <modelVersion>4.0.0</modelVersion>",
      "  <dependencies>",
      "  </dependencies>",
      "</project>",
    ].join("\n");
    const resolved = resolveJavaTestPackages(pom, "maven");
    assert.ok(resolved.updated.includes("junit-jupiter"));
    assert.ok(resolved.updated.includes("testng"));
    assert.ok(resolved.updated.includes("mockito-core"));
    assert.ok(resolved.updated.includes("mockk"));
    assert.ok(resolved.updated.includes("spring-test"));
    assert.ok(resolved.updated.includes("rest-assured"));
    assert.ok(resolved.updated.includes("wiremock-jre8"));
    assert.ok(resolved.updated.includes("selenium-java"));
  });

  it("injects missing Gradle dependencies", () => {
    const gradle = ["plugins {", "}", "dependencies {", "}"].join("\n");
    const resolved = resolveJavaTestPackages(gradle, "gradle");
    assert.ok(resolved.updated.includes('testImplementation "org.junit.jupiter:junit-jupiter'));
    assert.ok(resolved.updated.includes('testImplementation "org.testng:testng'));
    assert.ok(resolved.updated.includes('testImplementation "org.mockito:mockito-core'));
    assert.ok(resolved.updated.includes('testImplementation "io.mockk:mockk'));
    assert.ok(resolved.updated.includes('testImplementation "org.springframework:spring-test'));
    assert.ok(resolved.updated.includes('testImplementation "org.seleniumhq.selenium:selenium-java'));
  });
});

describe("set-workspace go test package selection", () => {
  it("skips already-required modules", () => {
    const goMod = [
      "module example.com/demo",
      "",
      "require (",
      "\tgithub.com/stretchr/testify v1.9.0",
      ")",
    ].join("\n");
    const resolved = resolveGoTestPackages(goMod);
    assert.ok(!resolved.missing.includes("github.com/stretchr/testify"));
    assert.ok(resolved.missing.includes("github.com/onsi/ginkgo/v2"));
    assert.ok(resolved.missing.includes("github.com/onsi/gomega"));
    assert.ok(resolved.missing.includes("github.com/go-resty/resty/v2"));
  });
});

describe("set-workspace php test package selection", () => {
  it("adds Symfony helpers when framework is detected", () => {
    const manifest = {
      require: { "symfony/framework-bundle": "^6.0" },
      "require-dev": { "phpunit/phpunit": "^10.0" },
    };
    const resolved = resolvePhpTestPackages(manifest);
    assert.ok(resolved.packages.includes("pestphp/pest"));
    assert.ok(resolved.packages.includes("symfony/browser-kit"));
    assert.ok(resolved.packages.includes("symfony/css-selector"));
    assert.ok(!resolved.missing.includes("phpunit/phpunit"));
    assert.ok(resolved.missing.includes("pestphp/pest"));
  });
});

describe("set-workspace ruby test package selection", () => {
  it("detects missing gems in Gemfile", () => {
    const gemfile = 'source "https://rubygems.org"\n\ngem "rspec"\n';
    const resolved = resolveRubyTestPackages(gemfile);
    assert.ok(!resolved.missing.includes("rspec"));
    assert.ok(resolved.missing.includes("minitest"));
    assert.ok(resolved.missing.includes("rack-test"));
    assert.ok(resolved.missing.includes("capybara"));
  });
});

describe("set-workspace flutter test package selection", () => {
  it("adds dev_dependencies when missing", () => {
    const pubspec = "name: app\n";
    const resolved = resolveFlutterTestPackages(pubspec);
    assert.ok(resolved.updated.includes("dev_dependencies:"));
    assert.ok(resolved.updated.includes("flutter_test"));
    assert.ok(resolved.updated.includes("integration_test"));
    assert.ok(resolved.updated.includes("mockito"));
  });
});

describe("set-workspace react native test package selection", () => {
  it("detects missing dev dependencies", () => {
    const pkg = { name: "rn-app", dependencies: { "react-native": "0.72.0" } };
    const resolved = resolveReactNativeTestPackages(pkg);
    assert.ok(resolved.missing.includes("jest"));
    assert.ok(resolved.missing.includes("@testing-library/react-native"));
    assert.ok(resolved.missing.includes("detox"));
  });
});

describe("set-workspace ios test package selection", () => {
  it("adds Quick/Nimble pods to Podfile", () => {
    const podfile = "platform :ios, '14.0'\n\ntarget 'App' do\nend\n";
    const resolved = resolveIosTestPackages(podfile);
    assert.ok(resolved.updated.includes("pod 'Quick'"));
    assert.ok(resolved.updated.includes("pod 'Nimble'"));
  });
});

describe("set-workspace android test package selection", () => {
  it("adds test dependencies to Gradle", () => {
    const gradle = "dependencies {\n}\n";
    const resolved = resolveAndroidTestPackages(gradle, false);
    assert.ok(resolved.updated.includes('testImplementation "junit:junit:4.13.2"'));
    assert.ok(resolved.updated.includes('androidTestImplementation "androidx.test.espresso:espresso-core:3.5.1"'));
  });
});
