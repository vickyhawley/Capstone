#!/usr/bin/env python3
"""Generate synthetic order history for the Groundwork corpus.

Real NFCS order data is out of scope for this project: the hub's client
records carry phone numbers, horse names, birthdays, staff notes and
delivery photographs, none of which can be anonymised safely at the scale
of a single town's catchment. This generator produces order history with
the same *shape* — repeat consumable purchases, local-delivery
constraints, clientKey bucketing, a realistic long tail — over the real
product catalogue, with entirely fabricated customers.

Shape decisions mirror the production hub (see docs/adr/):
  - clientKey is a normalised phone number, phone-first, email fallback.
  - Consumables (feed, bedding, haylage) repeat on a rough cycle;
    hardware and clothing are one-off or rare-repeat.
  - Products tagged `local-delivery-only` may only appear on orders
    whose delivery postcode falls inside the served radius.
  - Order channel is split between online and phone, because the
    production system unifies two streams and the assistant has to
    answer consistently across both.

Phone numbers use Ofcom's reserved drama range (07700 900000 – 07700
900999). Any number in that range is guaranteed by regulation never to
be assigned to a real subscriber, so leaked fixtures cannot spam a real
person. The range has 1000 numbers, so at most 1000 clients per run.

Deterministic: seeded, so regenerating produces an identical dataset and
eval cases stay valid across runs.
"""

from __future__ import annotations

import csv
import json
import random
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from pathlib import Path

SEED = 20260914
random.seed(SEED)

REPO_ROOT = Path(__file__).resolve().parents[1]
CATALOGUE = REPO_ROOT / "data" / "catalogue" / "products.csv"
OUT_DIR = REPO_ROOT / "data" / "synthetic"

# Postcode districts actually referenced in NFCS delivery conversations,
# plus their approximate road distance from the Ringwood base. The 20-mile
# free-delivery radius is a real policy; the distances here are rounded
# approximations sufficient for routing logic, not survey data.
DISTRICTS = [
    ("BH24", "Ringwood", 1, True),
    ("BH31", "Verwood", 6, True),
    ("BH21", "Wimborne", 11, True),
    ("BH23", "Christchurch", 10, True),
    ("BH25", "New Milton", 12, True),
    ("SO41", "Lymington", 15, True),
    ("SO42", "Brockenhurst", 12, True),
    ("SO43", "Lyndhurst", 14, True),
    ("SO40", "Totton", 19, True),
    ("SO51", "Romsey", 26, False),
    ("BH15", "Poole", 17, True),
    ("SP6", "Fordingbridge", 7, True),
    ("DT11", "Blandford", 31, False),
    ("SO22", "Winchester", 34, False),
]

FIRST = [
    "Alison", "Bryony", "Carla", "Danielle", "Eleanor", "Fiona", "Gemma",
    "Hannah", "Imogen", "Jessica", "Katie", "Lorna", "Megan", "Nadia",
    "Olivia", "Philippa", "Rachel", "Sophie", "Tessa", "Verity", "Adam",
    "Ben", "Callum", "Dominic", "Ewan", "Freddie", "Gareth", "Harry",
]
LAST = [
    "Ashworth", "Bramley", "Colborne", "Denby", "Elmsworth", "Fairhurst",
    "Gledhill", "Harrowby", "Inglefield", "Jardine", "Kelsall", "Lowther",
    "Mawdsley", "Norbury", "Oakden", "Pendleton", "Quinnell", "Rackham",
    "Shawcross", "Thurlow", "Underhill", "Vasey", "Warburton", "Yelland",
]

CONSUMABLE_TYPES = {"Feed", "Bedding", "Haylage", "Supplements", "treats", "dog feed"}

# Ofcom's reserved drama range: 07700 900000 – 07700 900999. Guaranteed
# unassigned, so a leaked fixture cannot spam a real person.
PHONE_PREFIX = "07700900"
PHONE_RANGE_SIZE = 1000


@dataclass
class Client:
    client_key: str
    name: str
    phone: str
    email: str
    postcode_district: str
    town: str
    distance_miles: int
    in_delivery_radius: bool


@dataclass
class OrderLine:
    sku: str
    title: str
    variant: str
    quantity: int
    unit_price: float
    local_delivery_only: bool


@dataclass
class Order:
    order_id: str
    client_key: str
    channel: str
    created_at: str
    delivery_method: str
    delivery_district: str
    lines: list
    total: float


def load_catalogue(path: Path):
    """Return (consumables, hardware) as lists of variant dicts."""
    consumables, hardware = [], []
    with path.open(newline="", encoding="utf-8") as fh:
        current = None
        for row in csv.DictReader(fh):
            if row["Title"].strip():
                current = row
            if not current:
                continue
            price = row.get("Variant Price", "").strip()
            if not price:
                continue
            try:
                price_f = float(price)
            except ValueError:
                continue
            if price_f <= 0:
                continue
            item = {
                "sku": row.get("Variant SKU", "").strip() or f"NFCS-{current['Handle'][:18]}",
                "title": current["Title"].strip(),
                "variant": row.get("Option1 Value", "").strip(),
                "type": current["Type"].strip(),
                "price": price_f,
                "local_delivery_only": "local-delivery-only" in current["Tags"].lower(),
            }
            (consumables if item["type"] in CONSUMABLE_TYPES else hardware).append(item)
    return consumables, hardware


def make_clients(n: int) -> list[Client]:
    if n > PHONE_RANGE_SIZE:
        raise ValueError(
            f"Ofcom drama range only holds {PHONE_RANGE_SIZE} numbers; "
            f"cannot generate {n} unique clients."
        )
    # Pre-sample unique phone suffixes so no two clients collide in the
    # drama range. With 60 clients in 1000 slots the birthday-problem
    # collision probability is ~83% if we just drew independently.
    phone_suffixes = random.sample(range(PHONE_RANGE_SIZE), n)

    clients: list[Client] = []
    used_names: set[str] = set()
    while len(clients) < n:
        name = f"{random.choice(FIRST)} {random.choice(LAST)}"
        if name in used_names:
            continue
        used_names.add(name)
        district, town, dist, served = random.choices(
            DISTRICTS, weights=[9, 7, 4, 5, 4, 3, 4, 3, 4, 1, 2, 3, 1, 1]
        )[0]
        phone = f"{PHONE_PREFIX}{phone_suffixes[len(clients)]:03d}"
        handle = name.lower().replace(" ", ".")
        clients.append(
            Client(
                client_key=f"phone:{phone}",
                name=name,
                phone=phone,
                email=f"{handle}@example.invalid",
                postcode_district=district,
                town=town,
                distance_miles=dist,
                in_delivery_radius=served,
            )
        )
    assert len({c.phone for c in clients}) == len(clients), "phone collision"
    return clients


def make_orders(clients, consumables, hardware, end: date, months: int = 6):
    """Build order history with realistic repeat behaviour.

    Client archetypes, matching the segments the production hub computes:
      - regular   : repeat consumable buyer, short cycle, still active
      - occasional: a few orders, long gaps
      - at-risk   : was regular, nothing recent
      - one-off   : single order, never returned
    """
    orders, seq = [], 1000
    start = end - timedelta(days=30 * months)

    for client in clients:
        archetype = random.choices(
            ["regular", "occasional", "at-risk", "one-off"],
            weights=[35, 30, 15, 20],
        )[0]

        if archetype == "regular":
            count, cycle, latest_gap = random.randint(6, 14), random.randint(14, 28), 10
        elif archetype == "occasional":
            count, cycle, latest_gap = random.randint(2, 5), random.randint(40, 75), 45
        elif archetype == "at-risk":
            count, cycle, latest_gap = random.randint(3, 7), random.randint(20, 35), 120
        else:
            count, cycle, latest_gap = 1, 0, random.randint(20, 150)

        # Regulars have a staple basket they re-order; that repetition is
        # what makes a "their usual" suggestion tool meaningful.
        staples = random.sample(consumables, k=min(random.randint(2, 4), len(consumables)))

        when = end - timedelta(days=latest_gap)
        for _ in range(count):
            if when < start:
                break
            lines = []
            for item in staples:
                if random.random() < 0.75:
                    lines.append(
                        OrderLine(
                            sku=item["sku"],
                            title=item["title"],
                            variant=item["variant"],
                            quantity=random.randint(1, 4),
                            unit_price=item["price"],
                            local_delivery_only=item["local_delivery_only"],
                        )
                    )
            if random.random() < 0.3 and hardware:
                extra = random.choice(hardware)
                lines.append(
                    OrderLine(
                        sku=extra["sku"],
                        title=extra["title"],
                        variant=extra["variant"],
                        quantity=1,
                        unit_price=extra["price"],
                        local_delivery_only=extra["local_delivery_only"],
                    )
                )
            if not lines:
                when -= timedelta(days=cycle or 30)
                continue

            bulky = any(line.local_delivery_only for line in lines)
            if bulky and not client.in_delivery_radius:
                # Outside the radius, bulky goods are collection only. This
                # is the constraint the delivery-zone tool has to enforce.
                method = "collection"
            elif bulky:
                method = "local delivery"
            else:
                method = random.choice(["local delivery", "collection", "courier"])

            seq += 1
            orders.append(
                Order(
                    order_id=f"NFCS-{seq}",
                    client_key=client.client_key,
                    channel=random.choices(["online", "phone"], weights=[55, 45])[0],
                    created_at=when.isoformat(),
                    delivery_method=method,
                    delivery_district=client.postcode_district,
                    lines=[asdict(line) for line in lines],
                    total=round(sum(l.quantity * l.unit_price for l in lines), 2),
                )
            )
            when -= timedelta(days=cycle or 30)

    orders.sort(key=lambda o: o.created_at)
    return orders


def main() -> None:
    consumables, hardware = load_catalogue(CATALOGUE)
    clients = make_clients(60)
    orders = make_orders(clients, consumables, hardware, end=date(2026, 9, 14))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with (OUT_DIR / "clients.jsonl").open("w", encoding="utf-8") as fh:
        for client in clients:
            fh.write(json.dumps(asdict(client)) + "\n")
    with (OUT_DIR / "orders.jsonl").open("w", encoding="utf-8") as fh:
        for order in orders:
            fh.write(json.dumps(asdict(order)) + "\n")

    revenue = sum(o.total for o in orders)
    repeat = sum(1 for c in clients if sum(1 for o in orders if o.client_key == c.client_key) > 1)
    outside = sum(1 for c in clients if not c.in_delivery_radius)
    collection_forced = sum(1 for o in orders if o.delivery_method == "collection"
                            and any(l["local_delivery_only"] for l in o.lines))

    print(f"catalogue      : {len(consumables)} consumable variants, {len(hardware)} hardware")
    print(f"clients        : {len(clients)} ({repeat} repeat, {outside} outside radius)")
    print(f"orders         : {len(orders)}  revenue £{revenue:,.2f}")
    print(f"bulky-outside  : {collection_forced} orders forced to collection")
    print(f"seed           : {SEED}")


if __name__ == "__main__":
    main()
