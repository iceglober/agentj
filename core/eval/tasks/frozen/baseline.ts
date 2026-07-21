import type { Task } from "../../../lib/eval/types";
import clinicNextSteps from "../dev/clinic-next-steps";
import clinicPunchlist from "../dev/clinic-punchlist";
import clinicTicket from "../dev/clinic-ticket";
import opsDigest from "../dev/ops-digest";
import opsParallel from "../dev/ops-parallel";
import opsRelease from "../dev/ops-release";
import opsSeed from "../dev/ops-seed";
import pyFixPricing from "../dev/py-fix-pricing";

/**
 * The first stable regression matrix. Task versions are the compatibility
 * boundary: behavior changes must create a new version rather than silently
 * changing the meaning of a recorded result.
 */
const baseline: Task[] = [
  clinicNextSteps,
  clinicPunchlist,
  clinicTicket,
  opsDigest,
  opsParallel,
  opsRelease,
  opsSeed,
  pyFixPricing,
].flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));

export default baseline;
