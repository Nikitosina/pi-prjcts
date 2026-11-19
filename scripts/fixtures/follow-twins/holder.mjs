// Reports an unknown-outcome write or holds one admission check (answering `afterHold` once released), as told by $HOLDER_CONTROL; its own state goes to $HOLDER_CONTROL.status.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export default {
  name: "holder",
  register(api) {
    const control = () => (existsSync(process.env.HOLDER_CONTROL) ? JSON.parse(readFileSync(process.env.HOLDER_CONTROL, "utf8")) : {});
    const status = { calls: 0, holding: false, held: 0, log: [] };
    const publish = () => writeFileSync(`${process.env.HOLDER_CONTROL}.status`, JSON.stringify(status));
    api.provide({
      uncertainWrites: async () => {
        const now = control();
        status.calls++;
        if (now.uncertain) return true;
        if (now.armed) {
          if (now.skip > 0) {
            writeFileSync(process.env.HOLDER_CONTROL, JSON.stringify({ ...now, skip: now.skip - 1 }));
            status.log.push(`pass ${status.calls}`);
            publish();
            return false;
          }
          writeFileSync(process.env.HOLDER_CONTROL, JSON.stringify({ ...now, armed: false }));
          status.holding = true;
          status.held++;
          status.log.push(`hold ${status.calls}`);
          publish();
          while (control().hold) await sleep(20);
          status.holding = false;
          status.log.push(`release ${status.calls}`);
          publish();
          return control().afterHold === true;
        }
        return control().afterHold === true;
      },
    });
  },
};
