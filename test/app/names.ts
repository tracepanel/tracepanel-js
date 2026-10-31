// biome-ignore-all lint/suspicious/noConsole: the app's debug output is what the tests read.
// Functions a minifier renames: a named function, a class's method, an arrow assigned to a const. Each dumps a value
// and gives back an error made where it runs.

export function placeOrder(total: number): Error {
  const order = { total };
  console.log(order); // placeOrder
  return new Error("placeOrder");
}

export class Cart {
  items = [1];

  checkout(): Error {
    const cart = { items: this.items };
    console.log(cart); // checkout
    return new Error("checkout");
  }
}

export const shipOrder = (id: number): Error => {
  const parcel = { id };
  console.log(parcel); // shipOrder
  return new Error("shipOrder");
};

/** Callbacks: an anonymous one, and one a const names. Each calls `probe` and gives back an error made there. */
export function eachOrder(ids: number[], probe: () => void): Error[] {
  return ids.map((id) => {
    probe(); // probe anonymous
    return new Error(`order ${id}`); // anonymous
  });
}

export function eachParcel(ids: number[], probe: () => void): Error[] {
  const onParcel = (id: number): Error => {
    probe(); // probe onParcel
    return new Error(`parcel ${id}`); // onParcel
  };
  return ids.map(onParcel);
}
