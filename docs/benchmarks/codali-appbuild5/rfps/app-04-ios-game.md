# RFP: EmberGrid

Platform: ios-game

A native iOS17+ turn-based tactical survival game using SpriteKit with SwiftUI menus. A complete original game loop with three authored stages, progression,save/resume and accessibility.

## Delivery contract
Build the application end to end in this workspace. Do not just describe a plan or return code snippets. Read this RFP and ENVIRONMENT.md, then implement, build and test as far as the provided environment permits. Use tools to create actual project files. You may discover available file,shell,Docdex,planning and testing tools. You may install public dependencies inside this workspace. No production deployment,external account creation,paid services or host administration is authorized. Keep secrets and personal host data out of the project.

One initial request is supplied; no further feature clarifications or evaluator fixes will be provided. Make reasonable product decisions and document them. Internal tool calls and self-corrections are allowed. Do not lower requirements to make tests pass. The common maximum is60minutes,100model calls,200tool calls,1million aggregate model tokens and8192output tokens per call, subject to64K context. Finish early only if the application is actually complete or you have accurately documented a blocker. Do not claim tests/builds you did not run.

Deliver source,dependency manifests and lockfiles,build configuration,tests,demo fixtures,and README. Include DELIVERY.md with implemented features,exact executed commands and results,known bugs,unverified checks,and missing requirements. Provide a machine-readable delivery.json with keys app,platform,buildCommand,runCommand,testCommand,artifactPaths,knownLimitations. Never include production secrets. Do not remove or rewrite RFP.md or ENVIRONMENT.md. No human will repair submitted code before scoring. Generated dependencies/build caches are excluded from source review but source and produced artifacts are preserved.

## Quality rubric (100points)
Features35: each of the35 numbered feature checks is worth1point. Build/delivery15,reliability/tests15,UI/UX15,code quality10,security10. Evaluation uses actual build/test/runtime evidence plus code review. An absent feature fails. An implemented but untestable native-platform behavior is marked unverified,not passed. Scores include verification coverage; environment gaps are disclosed separately. A screenshot/mockup alone does not prove behavior.

## Platform and data constraints
Use original shape-based assets; no external licensed art or paid services. No networking,ads or in-app purchases. A game should be playable from title through win/loss and stage progression, not just a static board. Turn sequence:validate player action,apply it,remove dead enemies,check win,then resolve remaining enemies in stable ID order,check loss,save. If Xcode is unavailable, deliver native source/project/tests and report the validation limitation honestly.

## Required features

### Core tactical loop
- F01: Render a12x12tile board with traversable tiles,walls,core,player,enemies and energy pickups.
- F02: Player moves one orthogonal tile per turn with touch controls.
- F03: Reject movement through walls,outside board or into occupied blocked tiles.
- F04: Each valid player action advances deterministic enemy turns exactly once.
- F05: Provide win and loss transitions with an explicit restart action.

### Combat and resources
- F06: Player starts with5health and3energy.
- F07: Adjacent attack costs1energy and deals2damage.
- F08: Enemies have3health and deal1damage when adjacent on their turn.
- F09: Energy pickup grants2energy up to maximum6.
- F10: Core has5health and losing it ends the stage.

### Enemy behavior
- F11: Include chaser and core-seeking enemy types with documented priorities.
- F12: Enemies cannot pass through walls or stack on occupied tiles.
- F13: Use deterministic tie-breaking for path decisions.
- F14: Show attack/move intentions or an understandable preview.
- F15: Include tests for blocked paths,adjacent attacks and enemy ordering.

### Stages and progression
- F16: Provide3distinct authored maps with increasing difficulty.
- F17: Unlock next stage only after completing prior stage.
- F18: Stage win requires all enemies defeated and core alive.
- F19: Record best score and stage completion persistently.
- F20: Calculate score as100per defeated enemy+20per remaining core health-5per turn,minimum0.

### Save and settings
- F21: Save board,turn,entities,resources and progression after each completed turn.
- F22: Resume an interrupted stage with equivalent deterministic state.
- F23: Validate corrupted/incompatible saves and offer safe reset.
- F24: Provide separate music/sound toggle or explicitly implemented sound setting.
- F25: Provide reduced-motion option and persist settings.

### Game UX
- F26: Title screen,stage selection,tutorial,pause,result and settings screens all work.
- F27: Show readable health,energy,core health,turn and score HUD.
- F28: Use original programmatic/vector visuals with consistent visual hierarchy.
- F29: Provide touch targets,contrast and non-color-only entity distinctions.
- F30: Support small/large iPhone safe areas and pause on backgrounding.

### Product delivery
- F31: All three maps are winnable with documented walkthroughs or scripted solver evidence.
- F32: Core game state and rules are separated from SpriteKit rendering.
- F33: Include deterministic unit tests for movement,combat,save/load and score.
- F34: Provide complete Xcode project or deterministic XcodeGen manifest and script.
- F35: README includes controls,rules,build,test,simulator and known limitations.

## Security requirements
- S1: Validate save versions,coordinates,entity IDs and bounded numeric state.
- S2: No arbitrary code/file execution from imported data.
- S3: No unintended network/tracking permissions or embedded secrets.
- S4: Save writes atomic and failure-safe.
- S5: Avoid crash-prone force casts/unwraps at scene and save boundaries.

## Evaluation contract
Every visible control must perform its claimed action. Demo data must be fictional and deterministic. Tests must validate behavior,not merely assert that files exist. Native signing/store publication is not required. Describe all environment blockers accurately.
