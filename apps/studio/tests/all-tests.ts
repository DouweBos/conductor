import { runAll } from "./runner";
import { projects } from "./projects.test";
import { qase } from "./qase.test";

void runAll([qase, projects]);
