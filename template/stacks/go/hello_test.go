package {{module}}

import "testing"

func TestHelloGreetsByName(t *testing.T) {
	if got := Hello("proj"); got != "hello, proj" {
		t.Fatalf("Hello() = %q", got)
	}
}
