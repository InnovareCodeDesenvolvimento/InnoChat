import { NichePage, nicheMetadata } from "@/components/landing/niche-page";

export const metadata = nicheMetadata("pet-shop");

/** Renderizada a cada requisição: os planos vêm do banco e o build de produção roda sem banco (mesma regra da landing). */
export const dynamic = "force-dynamic";

export default function PetShopPage() {
  return <NichePage slug="pet-shop" />;
}
