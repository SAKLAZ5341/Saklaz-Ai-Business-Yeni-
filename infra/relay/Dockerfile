# SAKLAZ AI relay — üretim imajı (Sprint 3 A2)
#
# İki aşama:
#   build:   bağımlılıklar kilit dosyasından kurulur, relay + çalışma alanı paketleri tek dosyaya
#            paketlenir (apps/relay/scripts/build.mjs), yalnızca üretim bağımlılıkları ayrılır.
#   runtime: yalnızca dist/, migrations/ ve üretim node_modules'u. TypeScript kaynağı, test,
#            derleme aracı, npm/yarn/corepack ve HİÇBİR gizli bilgi imaja girmez.
#
# Gizli bilgiler (veritabanı parolası, JWT anahtarları, MFA anahtarı) imaja GÖMÜLMEZ; çalışma
# zamanında Docker secrets ile /run/secrets altına bağlanır (docker-compose.yml). Derleme bağlamı
# .dockerignore izin listesiyle sınırlıdır; infra/relay/secrets bağlama hiç girmez.
#
# Temel imajlar özetle (digest) sabitlenir; etiket değişse bile aynı imaj kullanılır.
# Özet, CI'daki "Temel imajların özetleri" adımında çözülmüştür (2026-11-13; çok mimarili dizin özeti).
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=1
# pnpm sürümü kök package.json'daki "packageManager" ile aynıdır.
RUN npm install -g --no-audit --no-fund pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/crypto/package.json packages/crypto/
COPY packages/protocol/package.json packages/protocol/
COPY apps/relay/package.json apps/relay/
COPY apps/agent/package.json apps/agent/
COPY packages/testkit/package.json packages/testkit/
COPY packages/win-keyprotect/package.json packages/win-keyprotect/
COPY packages/client-core/package.json packages/client-core/
# Kurulum betikleri çalıştırılmaz (--ignore-scripts): relay'in yerel modülü (@node-rs/argon2) önceden
# derlenmiş paket olarak gelir; derleme betiği gerektiren paketler (ajanın SQLCipher modülü) relay
# imajında kullanılmaz.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@saklaz/relay..."
COPY packages/crypto/src packages/crypto/src
COPY packages/protocol/src packages/protocol/src
COPY apps/relay/src apps/relay/src
COPY apps/relay/scripts apps/relay/scripts
COPY apps/relay/migrations apps/relay/migrations
# Çalışma alanı paketleri dist/main.mjs içine paketlenir; kaynak kodları imaja girmez (@saklaz silinir).
RUN pnpm --filter @saklaz/relay run build \
 && pnpm --filter @saklaz/relay deploy --prod --legacy --ignore-scripts /out \
 && rm -rf /out/node_modules/@saklaz \
 && test -f /out/node_modules/@node-rs/argon2/package.json \
 && test -f /out/node_modules/libsodium-wrappers-sumo/package.json

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# Kullanılmayan paket yöneticileri kaldırılır (saldırı yüzeyi ve güvenlik taraması gürültüsü).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
# Dosyalar root'a aittir ve çalışan kullanıcı (node) tarafından DEĞİŞTİRİLEMEZ.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /src/apps/relay/dist ./dist
COPY --from=build /src/apps/relay/migrations ./migrations
# Kök olmayan kullanıcı (node, uid 1000). Ayrıcalıklı port gerekmez: 8080.
USER node
EXPOSE 8080
# Canlılık denetimi: süreç ve olay döngüsü. (Veritabanı durumu /readyz'dedir; veritabanı geçici
# olarak koptuğunda konteynerin gereksiz yere yeniden başlatılmaması için canlılığa katılmaz.)
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SAKLAZ_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["node", "dist/main.mjs"]
CMD ["serve"]
