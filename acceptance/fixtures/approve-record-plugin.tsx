import { makePlugin } from "@sweatpants/react-chat";
import { approveRecord } from "./approve-record.ts";

function Approval({
  receipt,
  onRespond,
  disabled,
}: {
  receipt: string;
  onRespond: (value: { approved: boolean }) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <p>Recorded: {receipt}</p>
      <button disabled={disabled} onClick={() => onRespond({ approved: true })}>
        Approve completion
      </button>
      <button disabled={disabled} onClick={() => onRespond({ approved: false })}>
        Decline completion
      </button>
    </div>
  );
}
export const approvalPlugin = makePlugin(approveRecord)
  .onElicit({
    approve: function* (input, ctx) {
      const content = yield* ctx.render(Approval, { receipt: input.context.receipt });
      return { action: "accept", content };
    },
  })
  .build();
