# SAKLAZ AI relay — üretim imajı (TASLAK: Sprint 2'de Docker ortamı olmadığından derlenip denenmedi)
# BİLİNEN EKSİK: Kaynak kod ".js" uzantılı içe aktarmalar kullanır; Node'un tip ayıklaması bunları ".ts"ye
# çevirmez. Bu yüzden aşağıdaki CMD bu haliyle ÇALIŞMAZ. Üretim derleme adımı (tsc → dist) Sprint 5'te
# eklenecek. Giriş noktası (src/main.ts) Sprint 2'de gerçek PostgreSQL ile ayrı bir süreç olarak sınandı.
# Kurallar: kök olmayan kullanıcı, salt okunur kök dosya sistemi (compose'da), kilitli bağımlılıklar.
FROM node:22.23.4-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/crypto packages/crypto
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN pnpm install --frozen-lockfile --filter @saklaz/relay... && pnpm --filter @saklaz/relay deploy --prod /out

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /src/packages /packages
USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/main.ts"]
