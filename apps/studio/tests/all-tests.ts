import { runAll } from "./runner";
import { flowProperties } from "./flowProperties.test";
import { projects } from "./projects.test";
import { qase } from "./qase.test";

void runAll([qase, projects, flowProperties]);
