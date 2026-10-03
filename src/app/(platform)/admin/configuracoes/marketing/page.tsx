import { getMetaConfigAction } from "@/modules/meta/actions";
import { MetaPixelCard } from "@/components/admin/meta-pixel-card";

export default async function ConfiguracoesMarketingPage() {
  const meta = await getMetaConfigAction();
  return (
    <div className="flex flex-col gap-6">
      <MetaPixelCard initial={meta.ok ? meta.data : null} />
    </div>
  );
}
